pragma solidity 0.8.9;
import {UUPSUpgradeable} from '@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol';

contract MockOracleUpgraded is UUPSUpgradeable {
  function _authorizeUpgrade(address) internal override {}
}
