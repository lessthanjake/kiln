// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @title INetworkedArt
/// @notice The interface for an artist's one-of-one collection.
interface INetworkedArt {
    /// @notice Onchain metadata for one 1/1 token.
    struct TokenData {
        string    name;
        string    description;
        address[] artifact;
        uint256   lotId;
        uint32    renderer;
        uint128   data;
    }

    /// @notice Inputs to every mint path.
    struct MintParams {
        uint256 tokenId;
        bytes[] artifact;
        string  name;
        string  description;
        uint32  rendererIndex;
        uint128 rendererData;
    }

    /// @notice Emitted when a new 1/1 is minted.
    event TokenMinted(
        uint256 indexed tokenId,
        address indexed artist,
        uint32  indexed rendererIndex,
        uint256 lotId
    );

    /// @notice Emitted when a renderer is registered.
    event RendererRegistered(
        uint256 indexed index,
        address indexed renderer,
        string  name,
        uint256 version
    );

    /// @notice Emitted when artifact chunks are staged before mint.
    event ArtifactPrepared(uint256 indexed tokenId, uint256 chunksAdded, bool cleared);

    /// @notice Emitted when the collection name changes.
    event CollectionNameUpdated(string newName);
    /// @notice Emitted when the collection symbol changes.
    event CollectionSymbolUpdated(string newSymbol);
    /// @notice Emitted when the collection description changes.
    event CollectionDescriptionUpdated(string newDescription);
    /// @notice Emitted when the collection icon URI changes.
    event CollectionIconUpdated(string newIcon);
    /// @notice Emitted when the collection adopts the factory's current
    ///         auction house.
    event AuctionsUpdated(address indexed previousAuctions, address indexed newAuctions);

    /// @notice Caller is not the collection owner.
    error NotOwner();
    /// @notice Caller is not the collection's factory.
    error NotFactory();
    /// @notice No artifact chunks were supplied or prepared for the mint.
    error InvalidArtifact();
    /// @notice Token id zero is reserved and cannot be minted or prepared.
    error InvalidTokenId();
    /// @notice A required address was zero.
    error ZeroAddress();
    /// @notice A renderer address is zero, duplicated during init, or
    ///         does not expose the required identity methods.
    error InvalidRenderer();
    /// @notice The renderer address is already registered.
    error RendererAlreadyRegistered();
    /// @notice The renderer index is outside the registry.
    error UnknownRenderer();
    /// @notice The token already exists, or the factory-only first mint
    ///         was called on a non-empty collection.
    error TokenAlreadyMinted();
    /// @notice Ownership renunciation is disabled.
    error RenounceDisabled();
    /// @notice The one-shot initializer has already run.
    error AlreadyInitialized();
    /// @notice The supplied auction address does not match the factory's
    ///         current auction house.
    error AuctionsMismatch(address expected, address actual);

    /// @notice One-shot initializer. Locks after the first call.
    /// @dev Caller is unrestricted before initialization; factories must
    ///      deploy or clone and initialize atomically.
    function init(
        string  calldata name_,
        string  calldata symbol_,
        address artist,
        address auctions_,
        address defaultRenderer,
        address animationRenderer,
        address factory_
    ) external;

    /// @notice Mint a new 1/1 to the artist, with no auction lot.
    function mint(MintParams calldata params) external;

    /// @notice Mint a new 1/1 and create its first auction lot in one call.
    function mintToLot(
        MintParams calldata params,
        uint96  reserveUsd,
        uint40  expiresAt
    ) external payable returns (uint256 lotId);

    /// @notice Factory-only first mint. Refunds overpayment to `payer`.
    function factoryMintToLot(
        address payer,
        MintParams calldata params,
        uint96  reserveUsd,
        uint40  expiresAt
    ) external payable returns (uint256 lotId);

    /// @notice Adopt the factory's current auction house and synchronize
    ///         the patron edition the factory's registry pairs with this
    ///         collection, if any.
    /// @dev Collection owner only. `expectedAuctions` pins the value the
    ///      owner reviewed, so a concurrent factory update cannot be adopted.
    function updateAuctions(address expectedAuctions) external;

    /// @notice Stage artifact chunks for a token before it is minted.
    function prepareArtifact(uint256 tokenId, bytes[] calldata chunks, bool clear) external;

    /// @notice Register a new renderer. Append-only.
    function registerRenderer(address renderer) external returns (uint256 index);

    /// @notice The number of renderers registered.
    function rendererCount() external view returns (uint256);

    /// @notice The renderer at a given index.
    function rendererAt(uint32 index) external view returns (address);

    /// @notice The image URI for a token.
    function tokenImage(uint256 tokenId) external view returns (string memory);

    /// @notice The display name for a token.
    function tokenName(uint256 tokenId) external view returns (string memory);

    /// @notice The description for a token.
    function tokenDescription(uint256 tokenId) external view returns (string memory);

    /// @notice The raw artifact bytes for a token.
    function tokenArtifact(uint256 tokenId) external view returns (bytes memory);

    /// @notice The full onchain data for a token.
    function tokenData(uint256 tokenId) external view returns (TokenData memory);

    /// @notice The collection's display name.
    function name() external view returns (string memory);

    /// @notice The collection's symbol.
    function symbol() external view returns (string memory);

    /// @notice The collection's description.
    function description() external view returns (string memory);

    /// @notice The collection's icon URI.
    function icon() external view returns (string memory);

    /// @notice The collection's metadata as a base64 JSON data URI.
    function contractURI() external view returns (string memory);

    /// @notice Update the collection's display name.
    function setName(string calldata newName) external;

    /// @notice Update the collection's symbol.
    function setSymbol(string calldata newSymbol) external;

    /// @notice Update the collection's description.
    function setDescription(string calldata newDescription) external;

    /// @notice Update the collection's icon URI.
    function setIcon(string calldata newIcon) external;

    /// @notice The total number of tokens in this collection.
    function totalSupply() external view returns (uint256);

    /// @notice The current owner of the collection.
    function owner() external view returns (address);
}
