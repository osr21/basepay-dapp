// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
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
 * @title BatchPayV2
 * @notice Send USDC to multiple recipients in a single transaction.
 *         V2 adds batchSendWithPermit() — one EIP-2612 signature covers the
 *         entire batch total, eliminating the approve() transaction.
 */
contract BatchPayV2 {
    address public owner;
    address public feeCollector;
    uint256 public feeBps;
    bool    public paused;

    event BatchSent(
        address indexed sender,
        address indexed token,
        uint256 totalGross,
        uint256 totalFee,
        uint256 recipientCount,
        string  memo
    );
    event FeeCollectorUpdated(address indexed previous, address indexed next);
    event FeeBpsUpdated(uint256 previous, uint256 next);
    event OwnershipTransferred(address indexed previous, address indexed next);
    event Paused(address by);
    event Unpaused(address by);

    modifier onlyOwner() { require(msg.sender == owner, "BatchPayV2: not owner"); _; }
    modifier notPaused() { require(!paused, "BatchPayV2: paused"); _; }

    constructor(address _feeCollector, uint256 _feeBps) {
        require(_feeCollector != address(0), "BatchPayV2: zero address");
        require(_feeBps <= 1000, "BatchPayV2: fee > 10%");
        owner        = msg.sender;
        feeCollector = _feeCollector;
        feeBps       = _feeBps;
    }

    /**
     * @notice Classic flow: caller must have approved this contract for the total gross amount.
     */
    function batchSend(
        address token,
        address[] calldata recipients,
        uint256[] calldata amounts,
        string calldata memo
    ) external notPaused {
        _doBatch(token, msg.sender, recipients, amounts, memo);
    }

    /**
     * @notice Permit flow: sign one EIP-2612 message for the total gross amount,
     *         no approve() transaction required.
     * @param permitAmount  The value field in the permit — must be >= total gross
     * @param deadline      Unix timestamp for permit expiry
     * @param v, r, s       Permit signature components
     */
    function batchSendWithPermit(
        address token,
        address[] calldata recipients,
        uint256[] calldata amounts,
        string calldata memo,
        uint256 permitAmount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external notPaused {
        IERC20Permit(token).permit(msg.sender, address(this), permitAmount, deadline, v, r, s);
        _doBatch(token, msg.sender, recipients, amounts, memo);
    }

    function _doBatch(
        address token,
        address sender,
        address[] calldata recipients,
        uint256[] calldata amounts,
        string memory memo
    ) internal {
        require(token != address(0), "BatchPayV2: zero token");
        require(recipients.length > 0, "BatchPayV2: empty recipients");
        require(recipients.length == amounts.length, "BatchPayV2: length mismatch");
        require(recipients.length <= 200, "BatchPayV2: max 200 recipients");

        uint256 totalGross;
        uint256 totalFee;

        for (uint256 i = 0; i < recipients.length; i++) {
            require(recipients[i] != address(0), "BatchPayV2: zero recipient");
            require(amounts[i] > 0, "BatchPayV2: zero amount");

            uint256 fee = (amounts[i] * feeBps) / 10_000;
            uint256 net = amounts[i] - fee;
            totalGross += amounts[i];
            totalFee   += fee;

            if (fee > 0) {
                require(IERC20(token).transferFrom(sender, feeCollector, fee), "BatchPayV2: fee failed");
            }
            require(IERC20(token).transferFrom(sender, recipients[i], net), "BatchPayV2: payment failed");
        }

        emit BatchSent(sender, token, totalGross, totalFee, recipients.length, memo);
    }

    function quoteBatch(uint256[] calldata amounts)
        external view returns (uint256 totalGross, uint256 totalFee, uint256 totalNet)
    {
        for (uint256 i = 0; i < amounts.length; i++) {
            uint256 fee = (amounts[i] * feeBps) / 10_000;
            totalGross += amounts[i];
            totalFee   += fee;
            totalNet   += amounts[i] - fee;
        }
    }

    function setFeeCollector(address _new) external onlyOwner {
        require(_new != address(0), "BatchPayV2: zero address");
        emit FeeCollectorUpdated(feeCollector, _new);
        feeCollector = _new;
    }
    function setFeeBps(uint256 _new) external onlyOwner {
        require(_new <= 1000, "BatchPayV2: fee > 10%");
        emit FeeBpsUpdated(feeBps, _new);
        feeBps = _new;
    }
    function transferOwnership(address _new) external onlyOwner {
        require(_new != address(0), "BatchPayV2: zero address");
        emit OwnershipTransferred(owner, _new);
        owner = _new;
    }
    function pause()   external onlyOwner { paused = true;  emit Paused(msg.sender); }
    function unpause() external onlyOwner { paused = false; emit Unpaused(msg.sender); }
}
