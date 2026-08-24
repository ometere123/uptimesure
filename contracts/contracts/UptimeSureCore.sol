// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title UptimeSureCore
/// @notice Fully-funded service guarantees whose payout conditions are driven by bounded monitor observations.
/// @dev Trust model, stated precisely:
///      - The provider funds the full maximum liability up front. The contract never owes more than it holds.
///      - The MONITOR_ROLE is an oracle: it can only assert "this endpoint was healthy / unhealthy at time T".
///        It cannot choose the beneficiary, change the payout size, redirect compensation, withdraw provider
///        funds, extend a term, or create a guarantee. Every one of those is fixed at creation by the provider.
///      - The worst a compromised monitor can do is (a) assert false failures, which pays the beneficiary the
///        provider's pre-agreed compensation and is bounded by maxPayouts, or (b) withhold observations, which
///        pays nobody. Neither can move funds to a monitor-chosen address.
///      - DEFAULT_ADMIN_ROLE can pause and manage roles. It cannot move escrowed coverage either: there is no
///        admin path to `coverageToken.transfer`.
contract UptimeSureCore is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant MONITOR_ROLE = keccak256("MONITOR_ROLE");
    uint32 public constant MIN_CHECK_INTERVAL = 60;
    uint32 public constant MAX_CHECK_INTERVAL = 86_400;
    uint32 public constant MAX_LATENCY_MS = 30_000;
    uint64 public constant MAX_TERM = 366 days;
    uint64 public constant MAX_OBSERVATION_AGE = 10 minutes;
    uint64 public constant FUTURE_TOLERANCE = 30 seconds;

    /// @notice Grace period after `expiresAt` during which the monitor may still settle observations that were
    ///         taken inside the covered term, and during which the provider may not yet reclaim coverage.
    /// @dev Without this window a provider escapes a liability that genuinely occurred: an endpoint that fails
    ///      in the final minutes of the term could not be settled onchain (submitObservation would revert on
    ///      expiry) while `withdrawExpired` became callable one second later. The window is deliberately larger
    ///      than MAX_OBSERVATION_AGE so the age check, not the term boundary, is the binding constraint.
    uint64 public constant SETTLEMENT_WINDOW = 30 minutes;

    IERC20 public immutable coverageToken;
    uint256 public nextGuaranteeId = 1;
    uint256 public nextIncidentId = 1;

    struct CreateGuaranteeParams {
        address beneficiary;
        string endpointUrl;
        uint16 expectedStatus;
        string expectedFragment;
        uint32 maxLatencyMs;
        uint32 checkIntervalSecs;
        uint8 failureThreshold;
        uint32 minOutageSecs;
        uint96 payoutPerIncident;
        uint16 maxPayouts;
        uint64 expiresAt;
        uint256 coverageAmount;
    }

    struct Guarantee {
        address provider;
        address beneficiary;
        string endpointUrl;
        bytes32 criteriaHash;
        uint16 expectedStatus;
        string expectedFragment;
        uint32 maxLatencyMs;
        uint32 checkIntervalSecs;
        uint8 failureThreshold;
        uint32 minOutageSecs;
        uint96 payoutPerIncident;
        uint16 maxPayouts;
        uint16 paidPayouts;
        uint256 remainingCoverage;
        uint64 createdAt;
        uint64 expiresAt;
        uint64 firstFailureAt;
        uint64 lastObservedAt;
        uint8 consecutiveFailures;
        bool active;
        bool withdrawn;
    }

    struct Incident {
        uint256 guaranteeId;
        uint64 startedAt;
        uint64 confirmedAt;
        uint64 recoveredAt;
        uint96 payoutAmount;
        bytes32 confirmEvidenceHash;
        bytes32 recoveryEvidenceHash;
    }

    mapping(uint256 => Guarantee) private _guarantees;
    mapping(uint256 => Incident) private _incidents;
    mapping(uint256 => uint256) public activeIncidentId;

    /// @notice Replay protection for observations, namespaced per guarantee.
    /// @dev Keyed on keccak256(guaranteeId, observationId). A global observationId namespace would let one
    ///      guarantee permanently burn an identifier for every other guarantee, which is a cheap griefing
    ///      vector against an off-chain monitor that derives ids deterministically.
    mapping(bytes32 => bool) public observationUsed;

    event GuaranteeCreated(
        uint256 indexed guaranteeId,
        address indexed provider,
        address indexed beneficiary,
        string endpointUrl,
        bytes32 criteriaHash,
        uint256 coverageAmount
    );
    event GuaranteeFunded(uint256 indexed guaranteeId, uint256 amount, uint256 remainingCoverage);
    event ObservationRecorded(
        uint256 indexed guaranteeId,
        bytes32 indexed observationId,
        bool healthy,
        bytes32 evidenceHash,
        uint64 observedAt,
        uint8 consecutiveFailures
    );
    event IncidentConfirmed(
        uint256 indexed incidentId,
        uint256 indexed guaranteeId,
        uint64 startedAt,
        uint64 confirmedAt,
        uint96 payoutAmount,
        bytes32 evidenceHash
    );
    event IncidentRecovered(
        uint256 indexed incidentId,
        uint256 indexed guaranteeId,
        uint64 recoveredAt,
        bytes32 evidenceHash
    );
    event GuaranteeExhausted(uint256 indexed guaranteeId);
    event CoverageWithdrawn(uint256 indexed guaranteeId, address indexed provider, uint256 amount);

    error InvalidAddress();
    error InvalidEndpoint();
    error InvalidTerms();
    error GuaranteeNotActive();
    error GuaranteeNotExpired();
    error UnauthorizedProvider();
    error ObservationAlreadyUsed();
    error ObservationOutOfWindow();
    error ObservationTooSoon();
    error UnexpectedTokenBehaviour();

    /// @param token ERC20 used for coverage and compensation (Circle test USDC on Base Sepolia).
    /// @param monitor Address granted MONITOR_ROLE. Must differ from the deployer so that the key which can
    ///        assert outages is never the key which administers the contract.
    /// @dev The deployer receives DEFAULT_ADMIN_ROLE only. Granting MONITOR_ROLE to the deployer here and
    ///      renouncing it in a follow-up transaction would leave a window in which one key held both powers.
    constructor(address token, address monitor) {
        if (token == address(0) || monitor == address(0)) revert InvalidAddress();
        if (monitor == msg.sender) revert InvalidAddress();
        coverageToken = IERC20(token);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MONITOR_ROLE, monitor);
    }

    function createGuarantee(CreateGuaranteeParams calldata p)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 guaranteeId)
    {
        _validateCreateParams(p);

        guaranteeId = nextGuaranteeId++;
        bytes32 criteriaHash = keccak256(
            abi.encode(
                p.endpointUrl,
                p.expectedStatus,
                p.expectedFragment,
                p.maxLatencyMs,
                p.checkIntervalSecs,
                p.failureThreshold,
                p.minOutageSecs
            )
        );

        _guarantees[guaranteeId] = Guarantee({
            provider: msg.sender,
            beneficiary: p.beneficiary,
            endpointUrl: p.endpointUrl,
            criteriaHash: criteriaHash,
            expectedStatus: p.expectedStatus,
            expectedFragment: p.expectedFragment,
            maxLatencyMs: p.maxLatencyMs,
            checkIntervalSecs: p.checkIntervalSecs,
            failureThreshold: p.failureThreshold,
            minOutageSecs: p.minOutageSecs,
            payoutPerIncident: p.payoutPerIncident,
            maxPayouts: p.maxPayouts,
            paidPayouts: 0,
            remainingCoverage: p.coverageAmount,
            createdAt: uint64(block.timestamp),
            expiresAt: p.expiresAt,
            firstFailureAt: 0,
            lastObservedAt: 0,
            consecutiveFailures: 0,
            active: true,
            withdrawn: false
        });

        _pullExactly(msg.sender, p.coverageAmount);
        emit GuaranteeCreated(guaranteeId, msg.sender, p.beneficiary, p.endpointUrl, criteriaHash, p.coverageAmount);
    }

    function topUp(uint256 guaranteeId, uint256 amount) external whenNotPaused nonReentrant {
        Guarantee storage g = _guarantees[guaranteeId];
        if (!g.active || g.withdrawn || block.timestamp > g.expiresAt) revert GuaranteeNotActive();
        if (msg.sender != g.provider) revert UnauthorizedProvider();
        if (amount == 0) revert InvalidTerms();

        g.remainingCoverage += amount;
        _pullExactly(msg.sender, amount);
        emit GuaranteeFunded(guaranteeId, amount, g.remainingCoverage);
    }

    function submitObservation(
        uint256 guaranteeId,
        bytes32 observationId,
        bool healthy,
        bytes32 evidenceHash,
        uint64 observedAt
    ) external onlyRole(MONITOR_ROLE) whenNotPaused nonReentrant {
        Guarantee storage g = _guarantees[guaranteeId];
        if (!g.active || g.withdrawn) revert GuaranteeNotActive();
        // Observations may settle for a bounded window after the term ends, but only for moments that fall
        // inside the covered term. This closes the end-of-term escape without extending coverage.
        if (block.timestamp > uint256(g.expiresAt) + SETTLEMENT_WINDOW) revert GuaranteeNotActive();
        if (observationId == bytes32(0) || evidenceHash == bytes32(0)) revert InvalidTerms();
        if (observedAt > g.expiresAt) revert ObservationOutOfWindow();
        bytes32 replayKey = _observationKey(guaranteeId, observationId);
        if (observationUsed[replayKey]) revert ObservationAlreadyUsed();
        if (
            observedAt > block.timestamp + FUTURE_TOLERANCE
                || uint256(observedAt) + MAX_OBSERVATION_AGE < block.timestamp
        ) {
            revert ObservationOutOfWindow();
        }
        if (g.lastObservedAt != 0 && observedAt < g.lastObservedAt + g.checkIntervalSecs - 5) {
            revert ObservationTooSoon();
        }

        observationUsed[replayKey] = true;
        g.lastObservedAt = observedAt;

        if (healthy) {
            _recordHealthy(guaranteeId, g, evidenceHash, observedAt);
        } else {
            _recordFailure(guaranteeId, g, evidenceHash, observedAt);
        }

        emit ObservationRecorded(
            guaranteeId,
            observationId,
            healthy,
            evidenceHash,
            observedAt,
            g.consecutiveFailures
        );
    }

    /// @notice Returns unused coverage to the provider once the term and its settlement window have elapsed.
    /// @dev `whenNotPaused` is deliberate: pausing is the emergency brake, and a brake that still lets the
    ///      escrow drain is not a brake.
    function withdrawExpired(uint256 guaranteeId) external whenNotPaused nonReentrant {
        Guarantee storage g = _guarantees[guaranteeId];
        if (msg.sender != g.provider) revert UnauthorizedProvider();
        if (block.timestamp <= uint256(g.expiresAt) + SETTLEMENT_WINDOW) revert GuaranteeNotExpired();
        if (g.withdrawn) revert GuaranteeNotActive();

        g.withdrawn = true;
        g.active = false;
        uint256 amount = g.remainingCoverage;
        g.remainingCoverage = 0;
        emit CoverageWithdrawn(guaranteeId, g.provider, amount);
        if (amount != 0) coverageToken.safeTransfer(g.provider, amount);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function getGuarantee(uint256 guaranteeId) external view returns (Guarantee memory) {
        return _guarantees[guaranteeId];
    }

    function getIncident(uint256 incidentId) external view returns (Incident memory) {
        return _incidents[incidentId];
    }

    /// @notice Replay-protection key for an observation. Exposed so the off-chain monitor and any auditor can
    ///         check whether a specific observation has already been settled.
    function observationKey(uint256 guaranteeId, bytes32 observationId) external pure returns (bytes32) {
        return _observationKey(guaranteeId, observationId);
    }

    function _observationKey(uint256 guaranteeId, bytes32 observationId) private pure returns (bytes32) {
        return keccak256(abi.encode(guaranteeId, observationId));
    }

    /// @dev Credits only what the escrow actually received. A fee-on-transfer, rebasing or otherwise
    ///      non-standard token would otherwise let a guarantee promise more compensation than it holds.
    function _pullExactly(address from, uint256 amount) private {
        uint256 before = coverageToken.balanceOf(address(this));
        coverageToken.safeTransferFrom(from, address(this), amount);
        if (coverageToken.balanceOf(address(this)) - before != amount) revert UnexpectedTokenBehaviour();
    }

    function _recordHealthy(
        uint256 guaranteeId,
        Guarantee storage g,
        bytes32 evidenceHash,
        uint64 observedAt
    ) internal {
        g.firstFailureAt = 0;
        g.consecutiveFailures = 0;

        uint256 incidentId = activeIncidentId[guaranteeId];
        if (incidentId != 0) {
            Incident storage incident = _incidents[incidentId];
            incident.recoveredAt = observedAt;
            incident.recoveryEvidenceHash = evidenceHash;
            activeIncidentId[guaranteeId] = 0;
            emit IncidentRecovered(incidentId, guaranteeId, observedAt, evidenceHash);
        }
    }

    function _recordFailure(
        uint256 guaranteeId,
        Guarantee storage g,
        bytes32 evidenceHash,
        uint64 observedAt
    ) internal {
        if (g.consecutiveFailures == 0) g.firstFailureAt = observedAt;
        if (g.consecutiveFailures < type(uint8).max) g.consecutiveFailures += 1;

        bool thresholdReached = g.consecutiveFailures >= g.failureThreshold;
        bool outageLongEnough = observedAt >= g.firstFailureAt + g.minOutageSecs;
        // One confirmed incident per outage: further failures accumulate but cannot pay again until the
        // endpoint recovers and a new outage begins.
        if (!thresholdReached || !outageLongEnough || activeIncidentId[guaranteeId] != 0) return;

        uint96 payout = 0;
        if (g.paidPayouts < g.maxPayouts && g.remainingCoverage >= g.payoutPerIncident) {
            payout = g.payoutPerIncident;
            g.paidPayouts += 1;
            g.remainingCoverage -= payout;
        }

        uint256 incidentId = nextIncidentId++;
        _incidents[incidentId] = Incident({
            guaranteeId: guaranteeId,
            startedAt: g.firstFailureAt,
            confirmedAt: observedAt,
            recoveredAt: 0,
            payoutAmount: payout,
            confirmEvidenceHash: evidenceHash,
            recoveryEvidenceHash: bytes32(0)
        });
        activeIncidentId[guaranteeId] = incidentId;

        bool exhausted = g.paidPayouts >= g.maxPayouts || g.remainingCoverage < g.payoutPerIncident;
        if (exhausted) g.active = false;

        // Checks-effects-interactions: every storage write and every event is finalised before the external
        // token call, so a hostile or callback-bearing coverage token cannot observe or re-enter partial state.
        emit IncidentConfirmed(incidentId, guaranteeId, g.firstFailureAt, observedAt, payout, evidenceHash);
        if (exhausted) emit GuaranteeExhausted(guaranteeId);
        if (payout != 0) coverageToken.safeTransfer(g.beneficiary, payout);
    }

    function _validateCreateParams(CreateGuaranteeParams calldata p) internal view {
        if (p.beneficiary == address(0)) revert InvalidAddress();
        bytes memory endpoint = bytes(p.endpointUrl);
        if (endpoint.length < 12 || endpoint.length > 512) revert InvalidEndpoint();
        if (!_startsWithHttps(endpoint) || !_isMonitorableUrl(endpoint)) revert InvalidEndpoint();
        if (bytes(p.expectedFragment).length > 128) revert InvalidTerms();
        if (p.expectedStatus < 100 || p.expectedStatus > 599) revert InvalidTerms();
        if (p.maxLatencyMs < 100 || p.maxLatencyMs > MAX_LATENCY_MS) revert InvalidTerms();
        if (p.checkIntervalSecs < MIN_CHECK_INTERVAL || p.checkIntervalSecs > MAX_CHECK_INTERVAL) revert InvalidTerms();
        if (p.failureThreshold == 0 || p.failureThreshold > 10) revert InvalidTerms();
        uint32 minimumOutage = p.checkIntervalSecs * (uint32(p.failureThreshold) - 1);
        if (p.minOutageSecs < minimumOutage || p.minOutageSecs > 7 days) revert InvalidTerms();
        if (p.payoutPerIncident == 0 || p.maxPayouts == 0 || p.maxPayouts > 100) revert InvalidTerms();
        if (p.expiresAt <= block.timestamp + p.checkIntervalSecs || p.expiresAt > block.timestamp + MAX_TERM) {
            revert InvalidTerms();
        }
        uint256 fullLiability = uint256(p.payoutPerIncident) * uint256(p.maxPayouts);
        if (p.coverageAmount < fullLiability) revert InvalidTerms();
    }

    function _startsWithHttps(bytes memory value) private pure returns (bool) {
        bytes memory prefix = bytes("https://");
        if (value.length < prefix.length) return false;
        for (uint256 i = 0; i < prefix.length; i++) {
            if (value[i] != prefix[i]) return false;
        }
        return true;
    }

    /// @dev Rejects endpoints the off-chain monitor could interpret differently from the onchain record:
    ///      whitespace and control characters (request smuggling and log injection), the userinfo separator
    ///      (which can point a naive fetcher at an internal host while the string still reads like a public
    ///      URL), and any non-ASCII byte (homoglyph and IDN-confusable hosts). Full SSRF filtering happens
    ///      off-chain in supabase/functions/_shared/ssrf.ts, which also resolves DNS; this is the onchain floor.
    function _isMonitorableUrl(bytes memory value) private pure returns (bool) {
        for (uint256 i = 0; i < value.length; i++) {
            uint8 c = uint8(value[i]);
            if (c <= 0x20 || c >= 0x7F) return false;
            if (c == 0x40 || c == 0x5C) return false; // '@' or '\'
            if (c == 0x22 || c == 0x3C || c == 0x3E || c == 0x5E || c == 0x60) return false; // " < > ^ `
            if (c == 0x7B || c == 0x7D || c == 0x7C) return false; // { } |
        }
        return true;
    }
}
