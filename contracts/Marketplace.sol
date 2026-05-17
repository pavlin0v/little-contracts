// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title Marketplace
 * @dev Основной контракт условного депонирования (эскроу) и бронирования аренды GPU.
 * Управляет листингами от поставщиков GPU, получает и блокирует токены от
 * арендаторов, и распределяет средства (доля поставщика + комиссия казны + сжигание)
 * после успешного завершения аренды.
 */
contract Marketplace is ReentrancyGuard, AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant PROVIDER_ROLE = keccak256("PROVIDER_ROLE");

    IERC20 public immutable token;
    address public treasury;
    
    // Комиссия в базисных пунктах (например, 500 = 5.00%)
    uint256 public feeBps = 500; 

    uint256 public listingCount;
    uint256 public bookingCount;

    struct Listing { 
        address provider; 
        uint256 pricePerHour; 
        // Хэш (например, IPFS CID) с описанием возможностей и характеристик GPU
        string specHash; 
        bool active; 
    }
    
    struct Booking { 
        address renter; 
        uint256 listingId; 
        uint256 durationHours; 
        uint256 amount; 
        uint256 startTime; 
        uint256 endTime; 
        BookingStatus status; 
    }
    
    enum BookingStatus { PENDING, ACTIVE, COMPLETED, DISPUTED, CANCELLED }

    mapping(uint256 => Listing) public listings;
    mapping(uint256 => Booking) public bookings;

    event Listed(uint256 indexed listingId, address indexed provider, uint256 pricePerHour, string specHash);
    event Booked(uint256 indexed bookingId, address indexed renter, uint256 listingId, uint256 amount);
    event BookingCompleted(uint256 indexed bookingId, uint256 providerAmount, uint256 treasuryFee, uint256 burnedFee);
    event Disputed(uint256 indexed bookingId, address indexed by);

    /**
     * @dev Инициализация маркетплейса.
     * @param tokenAddress ERC20 токен для расчетов (GPURENT).
     * @param treasuryAddress Кошелек, куда отправляется доля комиссии протокола.
     */
    constructor(address tokenAddress, address treasuryAddress) {
        token = IERC20(tokenAddress);
        treasury = treasuryAddress;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /**
     * @dev Создает новый листинг GPU. Может вызываться только аккаунтами с ролью PROVIDER_ROLE.
     * @param pricePerHour Стоимость часа аренды в токенах.
     * @param specHash IPFS хэш с описанием характеристик GPU.
     * @return id Уникальный ID созданного листинга.
     */
    function listGPU(uint256 pricePerHour, string calldata specHash) external returns (uint256) {
        require(pricePerHour > 0, "price>0");
        require(hasRole(PROVIDER_ROLE, msg.sender), "not provider");
        
        uint256 id = listingCount++;
        listings[id] = Listing({ 
            provider: msg.sender, 
            pricePerHour: pricePerHour, 
            specHash: specHash, 
            active: true 
        });
        emit Listed(id, msg.sender, pricePerHour, specHash);
        return id;
    }

    /**
     * @dev Арендует GPU и блокирует токены для оплаты в эскроу.
     * @param listingId ID листинга для аренды.
     * @param durationHours Количество часов, на которое бронируется GPU.
     * @return id Созданный ID бронирования.
     */
    function bookGPU(uint256 listingId, uint256 durationHours) external nonReentrant returns (uint256) {
        require(durationHours > 0, "hours>0");
        Listing storage l = listings[listingId];
        require(l.active, "listing inactive");
        
        uint256 amount = l.pricePerHour * durationHours;
        
        // Перевод токенов от арендатора в эскроу (на этот контракт)
        token.safeTransferFrom(msg.sender, address(this), amount);
        
        uint256 id = bookingCount++;
        bookings[id] = Booking({ 
            renter: msg.sender, 
            listingId: listingId, 
            durationHours: durationHours, 
            amount: amount, 
            startTime: block.timestamp, 
            endTime: block.timestamp + (durationHours * 1 hours), 
            status: BookingStatus.ACTIVE 
        });
        
        emit Booked(id, msg.sender, listingId, amount);
        return id;
    }

    /**
     * @dev Подтверждает завершение аренды, инициируя выплату и распределение комиссий.
     * Может вызываться только арендатором.
     */
    function confirmCompletion(uint256 bookingId) external nonReentrant {
        Booking storage b = bookings[bookingId];
        Listing storage l = listings[b.listingId];
        require(b.status == BookingStatus.ACTIVE, "not active");
        require(msg.sender == b.renter, "only renter");

        // Распределение комиссии: общая комиссия вычисляется на основе feeBps
        uint256 feeTotal = (b.amount * feeBps) / 10000;
        uint256 treasuryShare = feeTotal / 2;     // 50% комиссии -> казна
        uint256 burnShare = feeTotal - treasuryShare; // 50% комиссии -> сжигается
        uint256 providerAmount = b.amount - feeTotal;

        // Перевод доли протокола в казну
        token.safeTransfer(treasury, treasuryShare);

        // Попытка активно сжечь токены через метод burn контракта токенов.
        // Если функция не поддерживается ERC20, отправка на адрес 0xdead.
        (bool success,) = address(token).call(abi.encodeWithSignature("burn(uint256)", burnShare));
        if (!success) {
            token.safeTransfer(address(0xdead), burnShare);
        }

        // Перевод доли поставщику
        token.safeTransfer(l.provider, providerAmount);

        b.status = BookingStatus.COMPLETED;

        emit BookingCompleted(bookingId, providerAmount, treasuryShare, burnShare);
    }

    /**
     * @dev Открывает спор для заморозки бронирования при возникновении проблемы с GPU.
     * Может вызываться как арендатором, так и поставщиком.
     */
    function disputeBooking(uint256 bookingId) external {
        Booking storage b = bookings[bookingId];
        require(b.status == BookingStatus.ACTIVE, "not active");
        
        Listing storage l = listings[b.listingId];
        require(msg.sender == b.renter || msg.sender == l.provider, "not participant");
        
        b.status = BookingStatus.DISPUTED;
        emit Disputed(bookingId, msg.sender);
    }

    /**
     * @dev Административная функция для возврата средств за оспоренное бронирование обратно арендатору.
     */
    function refundBooking(uint256 bookingId) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        Booking storage b = bookings[bookingId];
        require(b.status == BookingStatus.DISPUTED, "not disputed");
        
        b.status = BookingStatus.CANCELLED;
        // Возврат полной заблокированной суммы арендатору
        token.safeTransfer(b.renter, b.amount);
    }
}
