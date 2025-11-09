// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title ArcadiaVault - central treasury vault using SafeERC20
contract ArcadiaVault is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant TREASURER_ROLE = keccak256("TREASURER_ROLE");

    event Deposited(address indexed token, uint256 amount, address indexed from);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    constructor(address initialAdmin) {
        require(initialAdmin != address(0), "zero admin");
        _setupRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _setupRole(TREASURER_ROLE, initialAdmin);
    }

    /// @notice Deposit tokens into the vault (caller must approve)
    function deposit(IERC20 token, uint256 amount) external {
        require(amount > 0, "amount>0");
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(address(token), amount, msg.sender);
    }

    /// @notice Withdraw tokens from the vault (TREASURER_ROLE required)
    function withdraw(IERC20 token, address to, uint256 amount) external onlyRole(TREASURER_ROLE) {
        require(amount > 0, "amount>0");
        require(to != address(0), "to=0");
        token.safeTransfer(to, amount);
        emit Withdrawn(address(token), to, amount);
    }

    /// @notice Admin-only arbitrary call for emergency or ops
    function adminExecute(address target, uint256 value, bytes calldata data) external onlyRole(DEFAULT_ADMIN_ROLE) returns (bytes memory) {
        (bool success, bytes memory ret) = target.call{value: value}(data);
        require(success, "call failed");
        return ret;
    }
}
