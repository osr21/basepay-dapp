// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice TESTNET ONLY. Virtual accounting demonstration; no USDC, shares, or
/// redeemable tokens. Cannot be deployed on Base mainnet. No admin or deposits.
contract StockFlowSandbox {
    address public immutable owner;
    uint256 public constant PRICE = 100e6; // 100 virtual dollars per virtual share
    uint256 public constant DAY = 1 days;
    uint256 public balance = 1000e6;
    uint256 public position;
    uint256 public spent;
    uint256 public periodStart;
    uint256 public maxPerTrade = 25e6;
    uint256 public dailyLimit = 100e6;
    uint256 public expiresAt;
    bool public active = true;

    event PolicySaved(uint256 maxPerTrade, uint256 dailyLimit, uint256 expiresAt);
    event PolicyRevoked();
    event DemoPurchase(uint256 amount, uint256 shares, uint256 periodSpent);

    modifier onlyOwner() {
        require(msg.sender == owner, "StockFlow: not owner");
        _;
    }
    constructor() {
        require(block.chainid == 84532, "StockFlow: Base Sepolia only");
        owner = msg.sender;
        periodStart = block.timestamp;
        expiresAt = block.timestamp + 7 days;
    }
    function setPolicy(uint256 tradeLimit, uint256 dayLimit, uint256 expiry) external onlyOwner {
        require(tradeLimit > 0 && tradeLimit <= dayLimit && dayLimit <= 1000e6, "StockFlow: invalid limits");
        require(expiry > block.timestamp && expiry <= block.timestamp + 30 days, "StockFlow: invalid expiry");
        // Policy updates never erase spending in the current anchored period.
        _advance();
        maxPerTrade = tradeLimit;
        dailyLimit = dayLimit;
        expiresAt = expiry;
        active = true;
        emit PolicySaved(tradeLimit, dayLimit, expiry);
    }
    function revoke() external onlyOwner { active = false; emit PolicyRevoked(); }
    function buy(uint256 amount, uint256 minShares, uint256 deadline) external onlyOwner {
        require(active, "StockFlow: revoked");
        require(block.timestamp < expiresAt, "StockFlow: policy expired");
        require(block.timestamp <= deadline && deadline <= block.timestamp + 10 minutes, "StockFlow: quote expired");
        require(amount > 0 && amount <= maxPerTrade, "StockFlow: transaction limit");
        _advance();
        require(spent + amount <= dailyLimit, "StockFlow: daily limit");
        require(amount <= balance, "StockFlow: insufficient demo funds");
        uint256 shares = amount * 1e18 / PRICE;
        require(shares > 0 && shares >= minShares, "StockFlow: minimum shares");
        balance -= amount;
        position += shares;
        spent += amount;
        emit DemoPurchase(amount, shares, spent);
    }
    function getState() external view returns (
        uint256 demoBalance, uint256 demoPosition, uint256 effectiveSpent,
        uint256 transactionLimit, uint256 dayLimit, uint256 expiry, bool enabled
    ) {
        return (balance, position, block.timestamp >= periodStart + DAY ? 0 : spent,
            maxPerTrade, dailyLimit, expiresAt, active && block.timestamp < expiresAt);
    }
    function _advance() private {
        uint256 periods = (block.timestamp - periodStart) / DAY;
        if (periods > 0) { periodStart += periods * DAY; spent = 0; }
    }
}
