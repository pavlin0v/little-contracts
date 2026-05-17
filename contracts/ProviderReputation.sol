// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title ProviderReputation
 * @dev Управляет стейкингом поставщиков и репутацией для маркетплейса аренды GPU.
 * Поставщики должны внести минимальную сумму токенов (stake). Администраторы/Маркетплейсы
 * могут урезать (slash) стейк в случае подтвержденного злонамеренного поведения или споров.
 */
contract ProviderReputation is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant SLASH_ROLE = keccak256("SLASH_ROLE");

    IERC20 public immutable token;
    
    // Минимальная обязательная сумма стейка (1000 токенов)
    uint256 public minStake = 1000 * (10 ** 18);
    // Обязательное время ожидания перед выводом стейка
    uint256 public unstakeLock = 7 days;

    struct StakeInfo { 
        uint256 amount; 
        uint256 stakedAt; 
    }

    mapping(address => StakeInfo) public stakes;
    mapping(address => uint256) public reputation;

    event Staked(address indexed provider, uint256 amount);
    event Unstaked(address indexed provider, uint256 amount);
    event Slashed(address indexed provider, uint256 amount, string reason);

    /**
     * @dev Инициализирует контракт, задавая базовый токен.
     * @param tokenAddress Утилитарный ERC20 токен (GPURENT).
     */
    constructor(address tokenAddress) {
        token = IERC20(tokenAddress);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(SLASH_ROLE, msg.sender);
    }

    /**
     * @dev Внесение токенов в качестве гарантийного обеспечения для размещения GPU.
     * @param amount Количество токенов для стейкинга.
     */
    function stake(uint256 amount) external {
        require(amount >= minStake, "stake: below minimum");
        
        token.safeTransferFrom(msg.sender, address(this), amount);
        
        stakes[msg.sender].amount += amount;
        stakes[msg.sender].stakedAt = block.timestamp;
        
        // Базовое повышение репутации за стейкинг
        reputation[msg.sender] += 10;
        
        emit Staked(msg.sender, amount);
    }

    /**
     * @dev Вывод застейканных токенов при условии истечения периода блокировки.
     * @param amount Количество токенов для вывода.
     */
    function unStake(uint256 amount) external {
        StakeInfo storage s = stakes[msg.sender];
        require(s.amount >= amount, "unstake: insufficient");
        require(block.timestamp >= s.stakedAt + unstakeLock, "unstake: locked");
        
        s.amount -= amount;
        token.safeTransfer(msg.sender, amount);
        
        emit Unstaked(msg.sender, amount);
    }

    /**
     * @dev Наказывает недобросовестного поставщика, сжигая/изымая часть его стейка.
     * @param provider Поставщик, подвергающийся наказанию.
     * @param amount Количество изымаемых токенов.
     * @param reason Описание нарушения.
     */
    function slash(address provider, uint256 amount, string calldata reason) external onlyRole(SLASH_ROLE) {
        StakeInfo storage s = stakes[provider];
        require(s.amount >= amount && amount > 0, "slash: invalid");
        
        s.amount -= amount;
        
        // Попытка активно сжечь конфискованные токены
        (bool success,) = address(token).call(abi.encodeWithSignature("burn(uint256)", amount));
        if (!success) {
            // В случае неудачи: перевод на адрес 0xdead
            token.safeTransfer(address(0xdead), amount);
        }
        
        // Штраф к очкам репутации
        if (reputation[provider] >= 5) {
            reputation[provider] -= 5;
        }
        
        emit Slashed(provider, amount, reason);
    }

    /**
     * @dev Проверяет текущий размер стейка конкретного поставщика.
     * @param provider Адрес для проверки.
     * @return Текущее количество застейканных токенов.
     */
    function getStake(address provider) external view returns (uint256) { 
        return stakes[provider].amount; 
    }
}
