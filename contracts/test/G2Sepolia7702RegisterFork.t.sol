// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;
import "forge-std/Test.sol";

interface IEnsv2Registrar7702 {
    function makeCommitment(string calldata, address, bytes32, address, address, uint64, bytes32) external pure returns(bytes32);
    function commit(bytes32) external;
    function getRegisterPrice(string calldata,uint64,address) external view returns(uint256,uint256);
    function register(string calldata,address,bytes32,address,address,uint64,address,bytes32) external returns(uint256);
    function isAvailable(string calldata) external view returns(bool);
}
interface IERC20Approve7702 { function approve(address,uint256) external returns(bool); }

/// @notice Read-only Sepolia fork reproduction. Local vm.etch changes ONLY the forked Anvil EVM.
contract G2Sepolia7702RegisterForkTest is Test {
    address constant WALLET=0xF7Bf79AcB7F3702b9DbD397d8140ac9DE6Ce642C;
    address constant REGISTRAR=0xf633e7FC17e2bbE0D0965D18ec1821dcB754a3d3;
    address constant TOKEN=0x240b0316Df57887DBBE58b586508b19e633a14aa;
    bytes32 constant SECRET=keccak256("synthetic local-fork-only test commitment; never an owner wallet salt");
    string constant LABEL="cometens-fork-only-7702-test";
    uint64 constant DURATION=365 days;
    function setUp() public {
        if(block.chainid!=11155111) {vm.skip(true);return;}
        assertTrue(WALLET.code.length==23,"expected EIP7702 23-byte designator");
        bytes memory code = WALLET.code;
        assertEq(uint8(code[0]),0xef); assertEq(uint8(code[1]),0x01); assertEq(uint8(code[2]),0x00);
        assertTrue(IEnsv2Registrar7702(REGISTRAR).isAvailable(LABEL));
        bytes32 commitHash=IEnsv2Registrar7702(REGISTRAR).makeCommitment(LABEL,WALLET,SECRET,address(0),address(0),DURATION,bytes32(0));
        vm.prank(WALLET);
        IEnsv2Registrar7702(REGISTRAR).commit(commitHash);
        vm.warp(block.timestamp+61);
        (uint256 base,uint256 premium)=IEnsv2Registrar7702(REGISTRAR).getRegisterPrice(LABEL,DURATION,TOKEN);
        vm.prank(WALLET);
        assertTrue(IERC20Approve7702(TOKEN).approve(REGISTRAR,base+premium));
    }
    function attempt() internal returns(uint256) {
        vm.prank(WALLET);
        return IEnsv2Registrar7702(REGISTRAR).register(LABEL,WALLET,SECRET,address(0),address(0),DURATION,TOKEN,bytes32(0));
    }
    function test_7702DelegationBlocksNativeERC1155Receiver() public {
        vm.expectPartialRevert(bytes4(0x57f447ce));
        attempt();
    }
    function test_clearedDelegationAllowsSameNativeENSv2MintOnFork() public {
        vm.etch(WALLET,""); // LOCAL FORK ONLY; never alter live Sepolia or user wallet
        uint256 tokenId=attempt();
        assertTrue(tokenId!=0);
    }
}
