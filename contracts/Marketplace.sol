// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "./ProviderReputation.sol";

/**
 * @title Marketplace
 * @dev Основной контракт условного депонирования (эскроу) и бронирования аренды GPU.
 * Управляет листингами от поставщиков GPU, получает и блокирует токены от
 * арендаторов, и распределяет средства (доля поставщика + комиссия казны + сжигание)
 * после успешного завершения аренды. Право листить определяется наличием
 * минимального стейка в контракте ProviderReputation.
 */
contract Marketplace is ReentrancyGuard, AccessControl {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    ProviderReputation public immutable reputation;
    address public immutable treasury;

    // Комиссия в базисных пунктах (например, 500 = 5.00%)
    uint256 public feeBps = 500;

    uint256 public listingCount;
    uint256 public bookingCount;

    struct Listing {
        address provider;
        uint256 pricePerHour;
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
    mapping(uint256 => bool) public bookingRated;

    event Listed(uint256 indexed listingId, address indexed provider, uint256 pricePerHour, string specHash);
    event Booked(uint256 indexed bookingId, address indexed renter, uint256 listingId, uint256 amount);
    event BookingCompleted(uint256 indexed bookingId, uint256 providerAmount, uint256 treasuryFee, uint256 burnedFee);
    event Disputed(uint256 indexed bookingId, address indexed by);
    event Refunded(uint256 indexed bookingId, uint256 refundAmount, uint256 slashed);
    event ProviderRated(uint256 indexed bookingId, address indexed provider, uint8 score);

    constructor(address tokenAddress, address treasuryAddress, address reputationAddress) {
        token = IERC20(tokenAddress);
        treasury = treasuryAddress;
        reputation = ProviderReputation(reputationAddress);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /**
     * @dev Создаёт листинг GPU. Доступ открыт любому, у кого есть достаточный стейк
     * в ProviderReputation (минимум reputation.minStake()).
     */
    function listGPU(uint256 pricePerHour, string calldata specHash) external returns (uint256) {
        require(pricePerHour > 0, "price>0");
        require(reputation.getStake(msg.sender) >= reputation.minStake(), "insufficient stake");

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

    function bookGPU(uint256 listingId, uint256 durationHours) external nonReentrant returns (uint256) {
        require(durationHours > 0, "hours>0");
        Listing storage l = listings[listingId];
        require(l.active, "listing inactive");

        uint256 amount = l.pricePerHour * durationHours;

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

    function confirmCompletion(uint256 bookingId) external nonReentrant {
        Booking storage b = bookings[bookingId];
        Listing storage l = listings[b.listingId];
        require(b.status == BookingStatus.ACTIVE, "not active");
        require(msg.sender == b.renter, "only renter");

        uint256 feeTotal = (b.amount * feeBps) / 10000;
        uint256 treasuryShare = feeTotal / 2;
        uint256 burnShare = feeTotal - treasuryShare;
        uint256 providerAmount = b.amount - feeTotal;

        token.safeTransfer(treasury, treasuryShare);

        (bool success,) = address(token).call(abi.encodeWithSignature("burn(uint256)", burnShare));
        if (!success) {
            token.safeTransfer(address(0xdead), burnShare);
        }

        token.safeTransfer(l.provider, providerAmount);

        b.status = BookingStatus.COMPLETED;

        emit BookingCompleted(bookingId, providerAmount, treasuryShare, burnShare);
    }

    function disputeBooking(uint256 bookingId) external {
        Booking storage b = bookings[bookingId];
        require(b.status == BookingStatus.ACTIVE, "not active");

        Listing storage l = listings[b.listingId];
        require(msg.sender == b.renter || msg.sender == l.provider, "not participant");

        b.status = BookingStatus.DISPUTED;
        emit Disputed(bookingId, msg.sender);
    }

    /**
     * @dev Возврат средств арендатору по подтверждённому диспуту + slash провайдера.
     * Marketplace должен иметь SLASH_ROLE в ProviderReputation (выдаётся в deploy-скрипте).
     */
    function refundBooking(uint256 bookingId) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        Booking storage b = bookings[bookingId];
        require(b.status == BookingStatus.DISPUTED, "not disputed");

        b.status = BookingStatus.CANCELLED;
        token.safeTransfer(b.renter, b.amount);

        Listing storage l = listings[b.listingId];
        uint256 slashed = reputation.slashForDispute(l.provider);

        emit Refunded(bookingId, b.amount, slashed);
    }

    /**
     * @dev Опциональная оценка провайдера арендатором после успешного завершения аренды.
     * Один раз на бронирование, score 1..5.
     */
    function rateProvider(uint256 bookingId, uint8 score) external {
        Booking storage b = bookings[bookingId];
        require(b.status == BookingStatus.COMPLETED, "not completed");
        require(msg.sender == b.renter, "only renter");
        require(!bookingRated[bookingId], "already rated");

        bookingRated[bookingId] = true;
        address provider = listings[b.listingId].provider;
        reputation.recordRating(provider, score);

        emit ProviderRated(bookingId, provider, score);
    }
}
