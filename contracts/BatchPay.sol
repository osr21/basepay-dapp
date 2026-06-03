// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * @title BatchPay
 * @notice Send USDC to multiple recipients in a single transaction.
 *         Collects a flat protocol fee per batch (not per recipient).
 * @dev Deploy with:
 *   forge create --rpc-url https://mainnet.base.org \
 *     --private-key $DEPLOYER_PRIVATE_KEY \
 *     contracts/BatchPay.sol:BatchPay \
 *     --constructor-args 0xdb5019b8dfbccef8906c39b16a4870082eabbc4c 30
 */
contract BatchPay {
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

    modifier onlyOwner() { require(msg.sender == owner, "BatchPay: not owner"); _; }
    modifier notPaused() { require(!paused, "BatchPay: paused"); _; }

    constructor(address _feeCollector, uint256 _feeBps) {
        require(_feeCollector != address(0), "BatchPay: zero address");
        require(_feeBps <= 1000, "BatchPay: fee > 10%");
        owner        = msg.sender;
        feeCollector = _feeCollector;
        feeBps       = _feeBps;
    }

    /**
     * @notice Send `token` to multiple recipients in one tx.
     * @param token      ERC-20 token address (e.g. USDC on Base)
     * @param recipients Array of destination addresses
     * @param amounts    Amount for each recipient (gross, before fee)
     * @param memo       Optional label for the batch (e.g. "April payroll")
     */
    function batchSend(
        address token,
        address[] calldata recipients,
        uint256[] calldata amounts,
        string calldata memo
    ) external notPaused {
        require(token != address(0), "BatchPay: zero token");
        require(recipients.length > 0, "BatchPay: empty recipients");
        require(recipients.length == amounts.length, "BatchPay: length mismatch");
        require(recipients.length <= 200, "BatchPay: max 200 recipients");

        uint256 totalGross;
        uint256 totalFee;

        for (uint256 i = 0; i < recipients.length; i++) {
            require(recipients[i] != address(0), "BatchPay: zero recipient");
            require(amounts[i] > 0, "BatchPay: zero amount");

            uint256 fee = (amounts[i] * feeBps) / 10_000;
            uint256 net = amounts[i] - fee;
            totalGross += amounts[i];
            totalFee   += fee;

            if (fee > 0) {
                require(
                    IERC20(token).transferFrom(msg.sender, feeCollector, fee),
                    "BatchPay: fee transfer failed"
                );
            }
            require(
                IERC20(token).transferFrom(msg.sender, recipients[i], net),
                "BatchPay: payment transfer failed"
            );
        }

        emit BatchSent(msg.sender, token, totalGross, totalFee, recipients.length, memo);
    }

    /**
     * @notice Preview total gross, fee, and net for a batch of amounts.
     */
    function quoteBatch(uint256[] calldata amounts)
        external view
        returns (uint256 totalGross, uint256 totalFee, uint256 totalNet)
    {
        for (uint256 i = 0; i < amounts.length; i++) {
            uint256 fee = (amounts[i] * feeBps) / 10_000;
            totalGross += amounts[i];
            totalFee   += fee;
            totalNet   += amounts[i] - fee;
        }
    }

    function setFeeCollector(address _new) external onlyOwner {
        require(_new != address(0), "BatchPay: zero address");
        emit FeeCollectorUpdated(feeCollector, _new);
        feeCollector = _new;
    }
    function setFeeBps(uint256 _new) external onlyOwner {
        require(_new <= 1000, "BatchPay: fee > 10%");
        emit FeeBpsUpdated(feeBps, _new);
        feeBps = _new;
    }
    function transferOwnership(address _new) external onlyOwner {
        require(_new != address(0), "BatchPay: zero address");
        emit OwnershipTransferred(owner, _new);
        owner = _new;
    }
    function pause()   external onlyOwner { paused = true;  emit Paused(msg.sender); }
    function unpause() external onlyOwner { paused = false; emit Unpaused(msg.sender); }
}
