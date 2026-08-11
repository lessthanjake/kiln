// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { INetworkedArt } from "./INetworkedArt.sol";

/// @title  IRenderer
/// @notice Pluggable metadata renderer for `NetworkedArt` tokens.
/// @author VV × 1001
interface IRenderer {
    /// @notice Human-readable renderer name.
    function name() external view returns (string memory);
    /// @notice Renderer implementation version.
    function version() external view returns (uint256);

    /// @notice Full token metadata URI.
    function uri(uint256 tokenId, INetworkedArt.TokenData calldata token)
        external
        view
        returns (string memory);

    /// @notice Image URI extracted or derived from the token artifact.
    function imageURI(uint256 tokenId, INetworkedArt.TokenData calldata token)
        external
        view
        returns (string memory);

    /// @notice Animation URI as defined by the renderer.
    function animationURI(uint256 tokenId, INetworkedArt.TokenData calldata token)
        external
        view
        returns (string memory);
}
