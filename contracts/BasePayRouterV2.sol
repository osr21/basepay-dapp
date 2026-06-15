// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
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
 * @title BasePayRouterV2
 * @notice Routes USDC payments on Base, collecting a protocol fee.
 *         V2 adds sendWithPermit() — user signs an EIP-2612 message off-chain
 *         instead of submitting an approve() transaction, eliminating wallet
 *         security warnings (e.g. Blockaid false positives on new contracts).
 */
contract BasePayRouterV2 {
    address public owner;
    address public feeCollector;
    uint256 public feeBps;
    bool    public paused;

    string  public constant APP_NAME    = "BasePay";
    string  public constant APP_VERSION = "2.0.0";
    string  public constant NETWORK     = "Base Mainnet";

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

    modifier onlyOwner() {
        require(msg.sender == owner, "BasePayRouterV2: not owner");
        _;
    }
    modifier notPaused() {
        require(!paused, "BasePayRouterV2: paused");
        _;
    }

    constructor(address _feeCollector, uint256 _feeBps) {
        require(_feeCollector != address(0), "BasePayRouterV2: zero address");
        require(_feeBps <= 1000, "BasePayRouterV2: fee > 10%");
        owner        = msg.sender;
        feeCollector = _feeCollector;
        feeBps       = _feeBps;
    }

    /**
     * @notice Transfer with pre-approved allowance (classic flow).
     */
    function send(
        address token,
        address recipient,
        uint256 amount,
        string calldata memo
    ) external notPaused {
        _doSend(token, msg.sender, recipient, amount, memo);
    }

    /**
     * @notice Transfer using an EIP-2612 permit signature.
     *         No prior approve() transaction required — the user signs a
     *         typed message off-chain and this contract consumes it.
     *
     *         Front-run protection: if another party already consumed this
     *         permit nonce (setting the allowance), we skip the permit call
     *         rather than reverting, and proceed with the existing allowance.
     *
     * @param deadline  Unix timestamp after which the permit is invalid
     * @param v, r, s   Components of the secp256k1 permit signature
     */
    function sendWithPermit(
        address token,
        address recipient,
        uint256 amount,
        string calldata memo,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external notPaused {
        if (IERC20Permit(token).allowance(msg.sender, address(this)) < amount) {
            IERC20Permit(token).permit(msg.sender, address(this), amount, deadline, v, r, s);
        }
        _doSend(token, msg.sender, recipient, amount, memo);
    }

    function _doSend(
        address token,
        address sender,
        address recipient,
        uint256 amount,
        string memory memo
    ) internal {
        require(token     != address(0), "BasePayRouterV2: zero token");
        require(recipient != address(0), "BasePayRouterV2: zero recipient");
        require(amount    >  0,          "BasePayRouterV2: zero amount");

        uint256 feeAmount = (amount * feeBps) / 10_000;
        uint256 netAmount = amount - feeAmount;

        if (feeAmount > 0) {
            require(
                IERC20(token).transferFrom(sender, feeCollector, feeAmount),
                "BasePayRouterV2: fee transfer failed"
            );
        }
        require(
            IERC20(token).transferFrom(sender, recipient, netAmount),
            "BasePayRouterV2: payment transfer failed"
        );

        emit Payment(sender, recipient, token, amount, feeAmount, netAmount, memo);
    }

    function quote(uint256 amount) external view returns (uint256 feeAmount, uint256 netAmount) {
        feeAmount = (amount * feeBps) / 10_000;
        netAmount = amount - feeAmount;
    }

    function appInfo() external pure returns (string memory name, string memory version, string memory network) {
        return (APP_NAME, APP_VERSION, NETWORK);
    }

    function setFeeCollector(address _new) external onlyOwner {
        require(_new != address(0), "BasePayRouterV2: zero address");
        emit FeeCollectorUpdated(feeCollector, _new);
        feeCollector = _new;
    }
    function setFeeBps(uint256 _new) external onlyOwner {
        require(_new <= 1000, "BasePayRouterV2: fee > 10%");
        emit FeeBpsUpdated(feeBps, _new);
        feeBps = _new;
    }
    function transferOwnership(address _new) external onlyOwner {
        require(_new != address(0), "BasePayRouterV2: zero address");
        emit OwnershipTransferred(owner, _new);
        owner = _new;
    }
    function pause()   external onlyOwner { paused = true;  emit Paused(msg.sender); }
    function unpause() external onlyOwner { paused = false; emit Unpaused(msg.sender); }
}
