// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * @title SubscriptionManager
 * @notice Allows payers to pre-authorise recurring USDC pulls by a merchant/payee.
 *         - Payer calls `subscribe`, setting amount + interval + merchant.
 *         - Merchant (or anyone) calls `charge` once per interval.
 *         - Payer can cancel at any time.
 *         - Protocol fee collected on each charge.
 * @dev Deploy with:
 *   forge create --rpc-url https://mainnet.base.org \
 *     --private-key $DEPLOYER_PRIVATE_KEY \
 *     contracts/SubscriptionManager.sol:SubscriptionManager \
 *     --constructor-args 0xdb5019b8dfbccef8906c39b16a4870082eabbc4c 30
 */
contract SubscriptionManager {
    struct Subscription {
        address payer;
        address payee;
        address token;
        uint256 amount;      // gross per charge
        uint256 interval;    // seconds between charges
        uint256 lastCharged; // timestamp of last successful charge (0 = never)
        uint256 startTime;   // when the subscription became active
        bool    active;
        string  memo;
    }

    address public owner;
    address public feeCollector;
    uint256 public feeBps;
    uint256 public subCount;

    mapping(uint256 => Subscription) public subscriptions;

    event Subscribed(
        uint256 indexed id,
        address indexed payer,
        address indexed payee,
        address token,
        uint256 amount,
        uint256 interval,
        string  memo
    );
    event Charged(uint256 indexed id, address indexed payer, uint256 grossAmount, uint256 feeAmount, uint256 netAmount);
    event Cancelled(uint256 indexed id, address indexed by);
    event FeeCollectorUpdated(address indexed previous, address indexed next);
    event FeeBpsUpdated(uint256 previous, uint256 next);
    event OwnershipTransferred(address indexed previous, address indexed next);

    modifier onlyOwner() { require(msg.sender == owner, "SubMgr: not owner"); _; }

    constructor(address _feeCollector, uint256 _feeBps) {
        require(_feeCollector != address(0), "SubMgr: zero address");
        require(_feeBps <= 1000, "SubMgr: fee > 10%");
        owner        = msg.sender;
        feeCollector = _feeCollector;
        feeBps       = _feeBps;
    }

    /**
     * @notice Create a recurring payment authorisation.
     *         The payer must keep a token allowance >= amount for this contract.
     * @param token    ERC-20 token (e.g. USDC)
     * @param payee    Merchant/recipient address
     * @param amount   Gross amount per charge
     * @param interval Seconds between charges (min 1 day, max 366 days)
     * @param memo     Optional label (e.g. "Netflix", "SaaS plan")
     * @return id      Subscription ID
     */
    function subscribe(
        address token,
        address payee,
        uint256 amount,
        uint256 interval,
        string calldata memo
    ) external returns (uint256 id) {
        require(token    != address(0), "SubMgr: zero token");
        require(payee    != address(0), "SubMgr: zero payee");
        require(payee    != msg.sender, "SubMgr: payer == payee");
        require(amount    > 0,          "SubMgr: zero amount");
        require(interval >= 1 days,     "SubMgr: interval < 1d");
        require(interval <= 366 days,   "SubMgr: interval > 366d");

        id = ++subCount;
        subscriptions[id] = Subscription({
            payer:       msg.sender,
            payee:       payee,
            token:       token,
            amount:      amount,
            interval:    interval,
            lastCharged: 0,
            startTime:   block.timestamp,
            active:      true,
            memo:        memo
        });

        emit Subscribed(id, msg.sender, payee, token, amount, interval, memo);
    }

    /**
     * @notice Execute a due charge for a subscription.
     *         Anyone can call this (e.g. the merchant's backend).
     * @param id Subscription ID
     */
    function charge(uint256 id) external {
        Subscription storage s = subscriptions[id];
        require(s.amount > 0,   "SubMgr: not found");
        require(s.active,       "SubMgr: cancelled");

        uint256 due = s.lastCharged == 0 ? s.startTime : s.lastCharged + s.interval;
        require(block.timestamp >= due, "SubMgr: not due yet");

        s.lastCharged = block.timestamp;

        uint256 fee = (s.amount * feeBps) / 10_000;
        uint256 net = s.amount - fee;

        if (fee > 0) {
            require(
                IERC20(s.token).transferFrom(s.payer, feeCollector, fee),
                "SubMgr: fee transfer failed"
            );
        }
        require(
            IERC20(s.token).transferFrom(s.payer, s.payee, net),
            "SubMgr: payment failed - check allowance"
        );

        emit Charged(id, s.payer, s.amount, fee, net);
    }

    /**
     * @notice Cancel a subscription. Only the payer or payee may cancel.
     */
    function cancel(uint256 id) external {
        Subscription storage s = subscriptions[id];
        require(s.amount > 0, "SubMgr: not found");
        require(s.active,     "SubMgr: already cancelled");
        require(msg.sender == s.payer || msg.sender == s.payee, "SubMgr: not authorised");

        s.active = false;
        emit Cancelled(id, msg.sender);
    }

    /**
     * @notice Check when a subscription is next chargeable (0 = due now / overdue).
     */
    function nextChargeAt(uint256 id) external view returns (uint256 timestamp) {
        Subscription storage s = subscriptions[id];
        if (!s.active || s.amount == 0) return type(uint256).max;
        return s.lastCharged == 0 ? s.startTime : s.lastCharged + s.interval;
    }

    /**
     * @notice Preview fee and net amounts for a subscription's gross amount.
     */
    function quote(uint256 amount) external view returns (uint256 fee, uint256 net) {
        fee = (amount * feeBps) / 10_000;
        net = amount - fee;
    }

    function setFeeCollector(address _new) external onlyOwner {
        require(_new != address(0), "SubMgr: zero address");
        emit FeeCollectorUpdated(feeCollector, _new);
        feeCollector = _new;
    }
    function setFeeBps(uint256 _new) external onlyOwner {
        require(_new <= 1000, "SubMgr: fee > 10%");
        emit FeeBpsUpdated(feeBps, _new);
        feeBps = _new;
    }
    function transferOwnership(address _new) external onlyOwner {
        require(_new != address(0), "SubMgr: zero address");
        emit OwnershipTransferred(owner, _new);
        owner = _new;
    }
}
