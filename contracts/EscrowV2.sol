// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IERC20Permit is IERC20 {
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
 * @title EscrowV2
 * @notice Hold USDC in escrow between a payer and a payee.
 *         V2 adds createWithPermit() — EIP-2612 signature replaces approve().
 */
contract EscrowV2 {
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

    modifier onlyOwner() { require(msg.sender == owner, "EscrowV2: not owner"); _; }

    constructor(address _feeCollector, uint256 _feeBps) {
        require(_feeCollector != address(0), "EscrowV2: zero address");
        require(_feeBps <= 1000, "EscrowV2: fee > 10%");
        owner        = msg.sender;
        feeCollector = _feeCollector;
        feeBps       = _feeBps;
    }

    /**
     * @notice Classic flow: caller must have approved this contract for `amount`.
     */
    function create(
        address token,
        address payee,
        uint256 amount,
        uint256 ttl,
        string calldata memo
    ) external returns (uint256 id) {
        return _doCreate(token, msg.sender, payee, amount, ttl, memo);
    }

    /**
     * @notice Permit flow: sign an EIP-2612 message, no approve() tx needed.
     * @param deadline  Permit deadline (should be >= block.timestamp + ttl for safety)
     * @param v, r, s   Permit signature components
     */
    function createWithPermit(
        address token,
        address payee,
        uint256 amount,
        uint256 ttl,
        string calldata memo,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 id) {
        IERC20Permit(token).permit(msg.sender, address(this), amount, deadline, v, r, s);
        return _doCreate(token, msg.sender, payee, amount, ttl, memo);
    }

    function _doCreate(
        address token,
        address payer,
        address payee,
        uint256 amount,
        uint256 ttl,
        string memory memo
    ) internal returns (uint256 id) {
        require(token  != address(0), "EscrowV2: zero token");
        require(payee  != address(0), "EscrowV2: zero payee");
        require(payee  != payer,      "EscrowV2: payer == payee");
        require(amount  > 0,          "EscrowV2: zero amount");
        require(ttl    >= 1 hours,    "EscrowV2: ttl < 1h");
        require(ttl    <= 365 days,   "EscrowV2: ttl > 365d");

        require(IERC20(token).transferFrom(payer, address(this), amount), "EscrowV2: deposit failed");

        id = ++escrowCount;
        escrows[id] = EscrowRecord({
            payer:  payer,
            payee:  payee,
            token:  token,
            amount: amount,
            expiry: block.timestamp + ttl,
            state:  State.Active,
            memo:   memo
        });

        emit EscrowCreated(id, payer, payee, token, amount, block.timestamp + ttl, memo);
    }

    function release(uint256 id) external {
        EscrowRecord storage e = escrows[id];
        require(e.amount > 0,             "EscrowV2: not found");
        require(e.state == State.Active,  "EscrowV2: not active");
        require(msg.sender == e.payee,    "EscrowV2: not payee");

        e.state = State.Released;
        uint256 fee = (e.amount * feeBps) / 10_000;
        uint256 net = e.amount - fee;

        if (fee > 0) require(IERC20(e.token).transfer(feeCollector, fee), "EscrowV2: fee failed");
        require(IERC20(e.token).transfer(e.payee, net), "EscrowV2: release failed");
        emit EscrowReleased(id, fee, net);
    }

    function refund(uint256 id) external {
        EscrowRecord storage e = escrows[id];
        require(e.amount > 0,              "EscrowV2: not found");
        require(e.state == State.Active,   "EscrowV2: not active");
        require(msg.sender == e.payer,     "EscrowV2: not payer");
        require(block.timestamp >= e.expiry, "EscrowV2: not expired");

        e.state = State.Refunded;
        require(IERC20(e.token).transfer(e.payer, e.amount), "EscrowV2: refund failed");
        emit EscrowRefunded(id, e.amount);
    }

    function quote(uint256 amount) external view returns (uint256 fee, uint256 net) {
        fee = (amount * feeBps) / 10_000;
        net = amount - fee;
    }

    function setFeeCollector(address _new) external onlyOwner {
        require(_new != address(0), "EscrowV2: zero address");
        emit FeeCollectorUpdated(feeCollector, _new);
        feeCollector = _new;
    }
    function setFeeBps(uint256 _new) external onlyOwner {
        require(_new <= 1000, "EscrowV2: fee > 10%");
        emit FeeBpsUpdated(feeBps, _new);
        feeBps = _new;
    }
    function transferOwnership(address _new) external onlyOwner {
        require(_new != address(0), "EscrowV2: zero address");
        emit OwnershipTransferred(owner, _new);
        owner = _new;
    }
}
