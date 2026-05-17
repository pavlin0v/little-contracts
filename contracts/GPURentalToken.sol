// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title GPURentalToken
 * @dev ERC20 токен для маркетплейса аренды GPU.
 * Этот токен (GPURENT) имеет фиксированную начальную эмиссию, отправляемую в казну (treasury).
 * Поддерживает сжигание через расширение ERC20Burnable, что используется
 * маркетплейсом для сжигания части собранных комиссий.
 */
contract GPURentalToken is ERC20, ERC20Burnable, AccessControl {
    bytes32 public constant ADMIN_ROLE = DEFAULT_ADMIN_ROLE;

    /**
     * @dev Конструктор для настройки токена.
     * @param treasury Адрес, представляющий казну проекта и получающий начальную эмиссию.
     */
    constructor(address treasury) ERC20("GPU Rental Token", "GPURENT") {
        _grantRole(ADMIN_ROLE, msg.sender);
        
        // Чеканим общий фиксированный объем в 100 миллионов токенов (с учетом 18 знаков)
        uint256 initial = 100000000 * (10 ** uint256(decimals()));
        _mint(treasury, initial);
    }
}
