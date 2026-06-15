// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IERC20Permit is IERC20 {
    function allowance(address owner, address spender) external view returns (uint256);
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/**
 * @title SubscriptionManagerV2
 * @notice Recurring USDC payment manager.
 *         V2 adds subscribeWithPermit() — one permit signature sets an
 *         allowance covering all future charges, no approve() tx needed.
 */
contract SubscriptionManagerV2 {
    struct Subscription {
        address payer;
        address payee;
        address token;
        uint256 amount;
        uint256 interval;
        uint256 lastCharged;
        uint256 startTime;
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

    modifier onlyOwner() { require(msg.sender == owner, "SubMgrV2: not owner"); _; }

    constructor(address _feeCollector, uint256 _feeBps) {
        require(_feeCollector != address(0), "SubMgrV2: zero address");
        require(_feeBps <= 1000, "SubMgrV2: fee > 10%");
        owner        = msg.sender;
        feeCollector = _feeCollector;
        feeBps       = _feeBps;
    }

    /**
     * @notice Classic flow: payer must maintain allowance >= amount for this contract.
     */
    function subscribe(
        address token,
        address payee,
        uint256 amount,
        uint256 interval,
        string calldata memo
    ) external returns (uint256 id) {
        return _doSubscribe(token, msg.sender, payee, amount, interval, memo);
    }

    /**
     * @notice Permit flow: sets an allowance via EIP-2612 (no approve() tx).
     *         Use permitAmount = type(uint256).max and a far-future deadline
     *         so recurring charges can proceed without re-approval.
     *
     *         Front-run protection: if a third party already consumed this permit
     *         nonce (setting the allowance), we skip the permit call rather than
     *         reverting, and proceed with the existing allowance.
     *
     * @param permitAmount  Allowance to grant — use max uint256 for open-ended subs
     * @param deadline      Permit deadline — use far future (e.g. year 2100) for recurring
     * @param v, r, s       Permit signature components
     */
    function subscribeWithPermit(
        address token,
        address payee,
        uint256 amount,
        uint256 interval,
        string calldata memo,
        uint256 permitAmount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 id) {
        if (IERC20Permit(token).allowance(msg.sender, address(this)) < permitAmount) {
            IERC20Permit(token).permit(msg.sender, address(this), permitAmount, deadline, v, r, s);
        }
        return _doSubscribe(token, msg.sender, payee, amount, interval, memo);
    }

    function _doSubscribe(
        address token,
        address payer,
        address payee,
        uint256 amount,
        uint256 interval,
        string memory memo
    ) internal returns (uint256 id) {
        require(token    != address(0), "SubMgrV2: zero token");
        require(payee    != address(0), "SubMgrV2: zero payee");
        require(payee    != payer,      "SubMgrV2: payer == payee");
        require(amount    > 0,          "SubMgrV2: zero amount");
        require(interval >= 1 days,     "SubMgrV2: interval < 1d");
        require(interval <= 366 days,   "SubMgrV2: interval > 366d");

        id = ++subCount;
        subscriptions[id] = Subscription({
            payer:       payer,
            payee:       payee,
            token:       token,
            amount:      amount,
            interval:    interval,
            lastCharged: 0,
            startTime:   block.timestamp,
            active:      true,
            memo:        memo
        });

        emit Subscribed(id, payer, payee, token, amount, interval, memo);
    }

    /**
     * @notice Collect a recurring charge. Anyone may call this once the interval
     *         has elapsed. The schedule is always anchored to the original
     *         startTime so late calls do not drift subsequent due dates forward.
     */
    function charge(uint256 id) external {
        Subscription storage s = subscriptions[id];
        require(s.amount > 0, "SubMgrV2: not found");
        require(s.active,     "SubMgrV2: cancelled");

        uint256 due = s.lastCharged == 0 ? s.startTime : s.lastCharged + s.interval;
        require(block.timestamp >= due, "SubMgrV2: not due yet");

        // Anchor to `due`, not `block.timestamp`, so the schedule cannot drift
        // forward when charge() is called late.
        s.lastCharged = due;

        uint256 fee = (s.amount * feeBps) / 10_000;
        uint256 net = s.amount - fee;

        if (fee > 0) {
            require(IERC20(s.token).transferFrom(s.payer, feeCollector, fee), "SubMgrV2: fee failed");
        }
        require(IERC20(s.token).transferFrom(s.payer, s.payee, net), "SubMgrV2: payment failed");

        emit Charged(id, s.payer, s.amount, fee, net);
    }

    function cancel(uint256 id) external {
        Subscription storage s = subscriptions[id];
        require(s.amount > 0, "SubMgrV2: not found");
        require(s.active,     "SubMgrV2: already cancelled");
        require(msg.sender == s.payer || msg.sender == s.payee, "SubMgrV2: not authorised");

        s.active = false;
        emit Cancelled(id, msg.sender);
    }

    function nextChargeAt(uint256 id) external view returns (uint256 timestamp) {
        Subscription storage s = subscriptions[id];
        if (!s.active || s.amount == 0) return type(uint256).max;
        return s.lastCharged == 0 ? s.startTime : s.lastCharged + s.interval;
    }

    function quote(uint256 amount) external view returns (uint256 fee, uint256 net) {
        fee = (amount * feeBps) / 10_000;
        net = amount - fee;
    }

    function setFeeCollector(address _new) external onlyOwner {
        require(_new != address(0), "SubMgrV2: zero address");
        emit FeeCollectorUpdated(feeCollector, _new);
        feeCollector = _new;
    }
    function setFeeBps(uint256 _new) external onlyOwner {
        require(_new <= 1000, "SubMgrV2: fee > 10%");
        emit FeeBpsUpdated(feeBps, _new);
        feeBps = _new;
    }
    function transferOwnership(address _new) external onlyOwner {
        require(_new != address(0), "SubMgrV2: zero address");
        emit OwnershipTransferred(owner, _new);
        owner = _new;
    }
}
