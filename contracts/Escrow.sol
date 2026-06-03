// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title Escrow
 * @notice Hold USDC in escrow between a payer and a payee.
 *         - Payer deposits funds and specifies a payee and expiry.
 *         - Payee can release (claim) the funds at any time before expiry.
 *         - Payer can refund after expiry if payee hasn't claimed.
 *         - A protocol fee is collected on release (not on refund).
 * @dev Deploy with:
 *   forge create --rpc-url https://mainnet.base.org \
 *     --private-key $DEPLOYER_PRIVATE_KEY \
 *     contracts/Escrow.sol:Escrow \
 *     --constructor-args 0xdb5019b8dfbccef8906c39b16a4870082eabbc4c 30
 */
contract Escrow {
    enum State { Active, Released, Refunded }

    struct EscrowRecord {
        address payer;
        address payee;
        address token;
        uint256 amount;
        uint256 expiry;
        State   state;
        string  memo;
    }

    address public owner;
    address public feeCollector;
    uint256 public feeBps;
    uint256 public escrowCount;

    mapping(uint256 => EscrowRecord) public escrows;

    event EscrowCreated(
        uint256 indexed id,
        address indexed payer,
        address indexed payee,
        address token,
        uint256 amount,
        uint256 expiry,
        string  memo
    );
    event EscrowReleased(uint256 indexed id, uint256 feeAmount, uint256 netAmount);
    event EscrowRefunded(uint256 indexed id, uint256 amount);
    event FeeCollectorUpdated(address indexed previous, address indexed next);
    event FeeBpsUpdated(uint256 previous, uint256 next);
    event OwnershipTransferred(address indexed previous, address indexed next);

    modifier onlyOwner() { require(msg.sender == owner, "Escrow: not owner"); _; }

    constructor(address _feeCollector, uint256 _feeBps) {
        require(_feeCollector != address(0), "Escrow: zero address");
        require(_feeBps <= 1000, "Escrow: fee > 10%");
        owner        = msg.sender;
        feeCollector = _feeCollector;
        feeBps       = _feeBps;
    }

    /**
     * @notice Create a new escrow. Payer must have approved this contract for `amount`.
     * @param token   ERC-20 to hold in escrow (e.g. USDC)
     * @param payee   Address that can claim the funds
     * @param amount  Gross amount (fee deducted on release)
     * @param ttl     Seconds until payer can reclaim (min 1 hour, max 365 days)
     * @param memo    Optional description
     * @return id     Escrow ID
     */
    function create(
        address token,
        address payee,
        uint256 amount,
        uint256 ttl,
        string calldata memo
    ) external returns (uint256 id) {
        require(token  != address(0), "Escrow: zero token");
        require(payee  != address(0), "Escrow: zero payee");
        require(payee  != msg.sender, "Escrow: payer == payee");
        require(amount  > 0,          "Escrow: zero amount");
        require(ttl    >= 1 hours,    "Escrow: ttl < 1h");
        require(ttl    <= 365 days,   "Escrow: ttl > 365d");

        require(
            IERC20(token).transferFrom(msg.sender, address(this), amount),
            "Escrow: deposit failed"
        );

        id = ++escrowCount;
        escrows[id] = EscrowRecord({
            payer:  msg.sender,
            payee:  payee,
            token:  token,
            amount: amount,
            expiry: block.timestamp + ttl,
            state:  State.Active,
            memo:   memo
        });

        emit EscrowCreated(id, msg.sender, payee, token, amount, block.timestamp + ttl, memo);
    }

    /**
     * @notice Payee claims the escrowed funds (fee deducted here).
     */
    function release(uint256 id) external {
        EscrowRecord storage e = escrows[id];
        require(e.amount > 0,             "Escrow: not found");
        require(e.state == State.Active,  "Escrow: not active");
        require(msg.sender == e.payee,    "Escrow: not payee");

        e.state = State.Released;

        uint256 fee = (e.amount * feeBps) / 10_000;
        uint256 net = e.amount - fee;

        if (fee > 0) {
            require(IERC20(e.token).transfer(feeCollector, fee), "Escrow: fee transfer failed");
        }
        require(IERC20(e.token).transfer(e.payee, net), "Escrow: release failed");

        emit EscrowReleased(id, fee, net);
    }

    /**
     * @notice Payer reclaims funds after expiry (no fee charged).
     */
    function refund(uint256 id) external {
        EscrowRecord storage e = escrows[id];
        require(e.amount > 0,              "Escrow: not found");
        require(e.state == State.Active,   "Escrow: not active");
        require(msg.sender == e.payer,     "Escrow: not payer");
        require(block.timestamp >= e.expiry, "Escrow: not expired");

        e.state = State.Refunded;
        require(IERC20(e.token).transfer(e.payer, e.amount), "Escrow: refund failed");
        emit EscrowRefunded(id, e.amount);
    }

    /**
     * @notice Preview fee and net for a given gross amount.
     */
    function quote(uint256 amount) external view returns (uint256 fee, uint256 net) {
        fee = (amount * feeBps) / 10_000;
        net = amount - fee;
    }

    function setFeeCollector(address _new) external onlyOwner {
        require(_new != address(0), "Escrow: zero address");
        emit FeeCollectorUpdated(feeCollector, _new);
        feeCollector = _new;
    }
    function setFeeBps(uint256 _new) external onlyOwner {
        require(_new <= 1000, "Escrow: fee > 10%");
        emit FeeBpsUpdated(feeBps, _new);
        feeBps = _new;
    }
    function transferOwnership(address _new) external onlyOwner {
        require(_new != address(0), "Escrow: zero address");
        emit OwnershipTransferred(owner, _new);
        owner = _new;
    }
}
