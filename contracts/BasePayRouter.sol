// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title BasePayRouter
 * @notice Routes USDC payments on Base, collecting a protocol fee for the deployer.
 * @dev Deploy with Foundry:
 *   forge create --rpc-url https://mainnet.base.org \
 *     --private-key $DEPLOYER_PRIVATE_KEY \
 *     contracts/BasePayRouter.sol:BasePayRouter \
 *     --constructor-args 0xdb5019b8dfbccef8906c39b16a4870082eabbc4c 30
 *
 * After deployment, set VITE_ROUTER_ADDRESS=<deployed address> in your env vars.
 */
contract BasePayRouter {
    // ─── State ────────────────────────────────────────────────────────────────
    address public owner;
    address public feeCollector;
    uint256 public feeBps;           // basis points: 30 = 0.30 %
    bool    public paused;

    string  public constant APP_NAME    = "BasePay";
    string  public constant APP_VERSION = "1.0.0";
    string  public constant NETWORK     = "Base Mainnet";

    // ─── Events ───────────────────────────────────────────────────────────────
    event Payment(
        address indexed sender,
        address indexed recipient,
        address indexed token,
        uint256 grossAmount,
        uint256 feeAmount,
        uint256 netAmount,
        string  memo
    );
    event FeeCollectorUpdated(address indexed previous, address indexed next);
    event FeeBpsUpdated(uint256 previous, uint256 next);
    event OwnershipTransferred(address indexed previous, address indexed next);
    event Paused(address by);
    event Unpaused(address by);

    // ─── Modifiers ────────────────────────────────────────────────────────────
    modifier onlyOwner() {
        require(msg.sender == owner, "BasePayRouter: not owner");
        _;
    }
    modifier notPaused() {
        require(!paused, "BasePayRouter: paused");
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────
    constructor(address _feeCollector, uint256 _feeBps) {
        require(_feeCollector != address(0), "BasePayRouter: zero address");
        require(_feeBps <= 1000, "BasePayRouter: fee > 10%");
        owner        = msg.sender;
        feeCollector = _feeCollector;
        feeBps       = _feeBps;
    }

    // ─── Core: send with fee ──────────────────────────────────────────────────
    /**
     * @notice Transfer `amount` of `token` from caller to `recipient`,
     *         deducting a protocol fee first.
     * @param token     ERC-20 token address (e.g. USDC on Base)
     * @param recipient Final destination of the net payment
     * @param amount    Gross amount (before fee) in token's smallest unit
     * @param memo      Optional human-readable note (stored in event log)
     */
    function send(
        address token,
        address recipient,
        uint256 amount,
        string calldata memo
    ) external notPaused {
        require(token     != address(0), "BasePayRouter: zero token");
        require(recipient != address(0), "BasePayRouter: zero recipient");
        require(amount    >  0,          "BasePayRouter: zero amount");

        uint256 feeAmount = (amount * feeBps) / 10_000;
        uint256 netAmount = amount - feeAmount;

        // Pull gross amount from sender in two separate transfers for clarity
        if (feeAmount > 0) {
            require(
                IERC20(token).transferFrom(msg.sender, feeCollector, feeAmount),
                "BasePayRouter: fee transfer failed"
            );
        }
        require(
            IERC20(token).transferFrom(msg.sender, recipient, netAmount),
            "BasePayRouter: payment transfer failed"
        );

        emit Payment(msg.sender, recipient, token, amount, feeAmount, netAmount, memo);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────
    function setFeeCollector(address _new) external onlyOwner {
        require(_new != address(0), "BasePayRouter: zero address");
        emit FeeCollectorUpdated(feeCollector, _new);
        feeCollector = _new;
    }

    function setFeeBps(uint256 _new) external onlyOwner {
        require(_new <= 1000, "BasePayRouter: fee > 10%");
        emit FeeBpsUpdated(feeBps, _new);
        feeBps = _new;
    }

    function transferOwnership(address _new) external onlyOwner {
        require(_new != address(0), "BasePayRouter: zero address");
        emit OwnershipTransferred(owner, _new);
        owner = _new;
    }

    function pause()   external onlyOwner { paused = true;  emit Paused(msg.sender); }
    function unpause() external onlyOwner { paused = false; emit Unpaused(msg.sender); }

    // ─── View helpers ─────────────────────────────────────────────────────────
    /**
     * @notice Compute fee and net amounts for a given gross amount.
     */
    function quote(uint256 amount)
        external view returns (uint256 feeAmount, uint256 netAmount)
    {
        feeAmount = (amount * feeBps) / 10_000;
        netAmount = amount - feeAmount;
    }

    /**
     * @notice Returns identity info for dApp verification.
     */
    function appInfo()
        external pure returns (string memory name, string memory version, string memory network)
    {
        return (APP_NAME, APP_VERSION, NETWORK);
    }
}
