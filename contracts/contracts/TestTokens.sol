// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {UptimeSureCore} from "./UptimeSureCore.sol";

/// @dev Test-only tokens that exercise hostile / non-standard ERC20 behaviour. Never deployed to any network.

/// @notice Transfers less than requested, like a fee-on-transfer token.
contract FeeOnTransferToken is ERC20 {
    uint256 public immutable feeBps;

    constructor(uint256 feeBps_) ERC20("Fee Token", "FEE") {
        feeBps = feeBps_;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * feeBps) / 10_000;
        super._update(from, to, value - fee);
        super._update(from, address(0xdead), fee);
    }
}

/// @notice Returns false instead of reverting on transfer. SafeERC20 must turn this into a revert.
contract FalseReturnToken {
    string public name = "False Token";
    string public symbol = "FALSE";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice Attempts to re-enter UptimeSureCore from inside a token transfer.
contract ReentrantToken is ERC20 {
    UptimeSureCore public core;
    uint256 public attackGuaranteeId;
    bool public reenterOnTransfer;
    bool public reentryAttempted;
    bool public reentryReverted;

    constructor() ERC20("Reentrant Token", "REENT") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(UptimeSureCore core_, uint256 guaranteeId) external {
        core = core_;
        attackGuaranteeId = guaranteeId;
        reenterOnTransfer = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (!reenterOnTransfer || address(core) == address(0)) return;
        reenterOnTransfer = false;
        reentryAttempted = true;
        try core.topUp(attackGuaranteeId, 1) {
            reentryReverted = false;
        } catch {
            reentryReverted = true;
        }
    }
}
