// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title ProviderReputation
 * @dev Управляет стейкингом поставщиков и рейтингом для маркетплейса аренды GPU.
 * Поставщики должны внести минимальную сумму токенов (stake), чтобы листить GPU.
 * Marketplace получает роль SLASH_ROLE для конфискации части стейка при подтверждённом диспуте,
 * и роль RATER_ROLE для записи оценок арендаторов после успешного завершения аренды.
 */
contract ProviderReputation is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant SLASH_ROLE = keccak256("SLASH_ROLE");
    bytes32 public constant RATER_ROLE = keccak256("RATER_ROLE");

    IERC20 public immutable token;

    // Минимальная обязательная сумма стейка (1000 токенов)
    uint256 public minStake = 1000 * (10 ** 18);
    // Обязательное время ожидания перед выводом стейка
    uint256 public unstakeLock = 7 days;
    // Доля стейка, конфискуемая при подтверждённом диспуте (1000 = 10%)
    uint256 public slashBps = 1000;

    struct StakeInfo {
        uint256 amount;
        uint256 stakedAt;
    }

    mapping(address => StakeInfo) public stakes;
    mapping(address => uint256) public reputation;

    // Рейтинг от арендаторов: сумма оценок и их количество.
    // Среднее = ratingSum * 100 / ratingCount (округлённое × 100 для дробной точности).
    mapping(address => uint256) public ratingSum;
    mapping(address => uint256) public ratingCount;

    event Staked(address indexed provider, uint256 amount);
    event Unstaked(address indexed provider, uint256 amount);
    event Slashed(address indexed provider, uint256 amount, string reason);
    event Rated(address indexed provider, uint8 score);
    event SlashBpsUpdated(uint256 oldBps, uint256 newBps);

    constructor(address tokenAddress) {
        token = IERC20(tokenAddress);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(SLASH_ROLE, msg.sender);
    }

    function stake(uint256 amount) external {
        require(amount >= minStake, "stake: below minimum");

        token.safeTransferFrom(msg.sender, address(this), amount);

        stakes[msg.sender].amount += amount;
        stakes[msg.sender].stakedAt = block.timestamp;

        reputation[msg.sender] += 10;

        emit Staked(msg.sender, amount);
    }

    function unStake(uint256 amount) external {
        StakeInfo storage s = stakes[msg.sender];
        require(s.amount >= amount, "unstake: insufficient");
        require(block.timestamp >= s.stakedAt + unstakeLock, "unstake: locked");

        s.amount -= amount;
        token.safeTransfer(msg.sender, amount);

        emit Unstaked(msg.sender, amount);
    }

    function slash(address provider, uint256 amount, string calldata reason) external onlyRole(SLASH_ROLE) {
        StakeInfo storage s = stakes[provider];
        require(s.amount >= amount && amount > 0, "slash: invalid");
        _slash(provider, amount, reason);
    }

    /**
     * @dev Конфисковать долю стейка провайдера за подтверждённый диспут.
     * Размер = stake * slashBps / 10000. Если стейка нет — возвращает 0 без реверта,
     * чтобы Marketplace мог завершить refund даже для провайдера без стейка
     * (теоретически невозможный кейс, но защита от блокировки возврата средств арендатору).
     */
    function slashForDispute(address provider) external onlyRole(SLASH_ROLE) returns (uint256) {
        uint256 current = stakes[provider].amount;
        if (current == 0) return 0;

        uint256 amount = (current * slashBps) / 10000;
        if (amount == 0) return 0;

        _slash(provider, amount, "dispute");
        return amount;
    }

    function _slash(address provider, uint256 amount, string memory reason) internal {
        stakes[provider].amount -= amount;

        // Попытка активно сжечь конфискованные токены; иначе — отправка на 0xdead
        (bool success,) = address(token).call(abi.encodeWithSignature("burn(uint256)", amount));
        if (!success) {
            token.safeTransfer(address(0xdead), amount);
        }

        if (reputation[provider] >= 5) {
            reputation[provider] -= 5;
        }

        emit Slashed(provider, amount, reason);
    }

    /**
     * @dev Записать оценку арендатора. Может вызываться только адресом с RATER_ROLE
     * (по дизайну — это контракт Marketplace, который проверяет, что оценку ставит
     * именно арендатор завершённой брони).
     * @param provider Оцениваемый провайдер.
     * @param score Оценка 1..5.
     */
    function recordRating(address provider, uint8 score) external onlyRole(RATER_ROLE) {
        require(score >= 1 && score <= 5, "rating: out of range");
        ratingSum[provider] += score;
        ratingCount[provider] += 1;
        emit Rated(provider, score);
    }

    /**
     * @dev Средняя оценка провайдера, умноженная на 100 (для дробной точности).
     * Возвращает 0, если оценок ещё нет.
     */
    function getAverageRating(address provider) external view returns (uint256) {
        uint256 count = ratingCount[provider];
        if (count == 0) return 0;
        return (ratingSum[provider] * 100) / count;
    }

    function setSlashBps(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(bps <= 10000, "bps: too high");
        emit SlashBpsUpdated(slashBps, bps);
        slashBps = bps;
    }

    function getStake(address provider) external view returns (uint256) {
        return stakes[provider].amount;
    }
}
