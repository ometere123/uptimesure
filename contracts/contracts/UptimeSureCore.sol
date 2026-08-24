// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title UptimeSureCore
/// @notice Fully-funded service guarantees whose payout conditions are driven by bounded monitor observations.
/// @dev The monitor cannot redirect funds. It can only submit observations; beneficiaries and payout caps are fixed at creation.
contract UptimeSureCore is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant MONITOR_ROLE = keccak256("MONITOR_ROLE");
    uint32 public constant MIN_CHECK_INTERVAL = 60;
    uint32 public constant MAX_CHECK_INTERVAL = 86_400;
    uint32 public constant MAX_LATENCY_MS = 30_000;
    uint64 public constant MAX_TERM = 366 days;
    uint64 public constant MAX_OBSERVATION_AGE = 10 minutes;
    uint64 public constant FUTURE_TOLERANCE = 30 seconds;

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

    constructor(address token) {
        if (token == address(0)) revert InvalidAddress();
        coverageToken = IERC20(token);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MONITOR_ROLE, msg.sender);
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

        coverageToken.safeTransferFrom(msg.sender, address(this), p.coverageAmount);
        emit GuaranteeCreated(guaranteeId, msg.sender, p.beneficiary, p.endpointUrl, criteriaHash, p.coverageAmount);
    }

    function topUp(uint256 guaranteeId, uint256 amount) external whenNotPaused nonReentrant {
        Guarantee storage g = _guarantees[guaranteeId];
        if (!g.active || g.withdrawn) revert GuaranteeNotActive();
        if (msg.sender != g.provider) revert UnauthorizedProvider();
        if (amount == 0) revert InvalidTerms();

        g.remainingCoverage += amount;
        coverageToken.safeTransferFrom(msg.sender, address(this), amount);
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
        if (!g.active || g.withdrawn || block.timestamp > g.expiresAt) revert GuaranteeNotActive();
        if (observationId == bytes32(0) || evidenceHash == bytes32(0)) revert InvalidTerms();
        if (observationUsed[observationId]) revert ObservationAlreadyUsed();
        if (observedAt > block.timestamp + FUTURE_TOLERANCE || observedAt + MAX_OBSERVATION_AGE < block.timestamp) {
            revert ObservationOutOfWindow();
        }
        if (g.lastObservedAt != 0 && observedAt < g.lastObservedAt + g.checkIntervalSecs - 5) {
            revert ObservationTooSoon();
        }

        observationUsed[observationId] = true;
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

    function withdrawExpired(uint256 guaranteeId) external nonReentrant {
        Guarantee storage g = _guarantees[guaranteeId];
        if (msg.sender != g.provider) revert UnauthorizedProvider();
        if (block.timestamp <= g.expiresAt) revert GuaranteeNotExpired();
        if (g.withdrawn) revert GuaranteeNotActive();

        g.withdrawn = true;
        g.active = false;
        uint256 amount = g.remainingCoverage;
        g.remainingCoverage = 0;
        if (amount != 0) coverageToken.safeTransfer(g.provider, amount);
        emit CoverageWithdrawn(guaranteeId, g.provider, amount);
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

        if (payout != 0) coverageToken.safeTransfer(g.beneficiary, payout);
        emit IncidentConfirmed(incidentId, guaranteeId, g.firstFailureAt, observedAt, payout, evidenceHash);

        if (g.paidPayouts >= g.maxPayouts || g.remainingCoverage < g.payoutPerIncident) {
            g.active = false;
            emit GuaranteeExhausted(guaranteeId);
        }
    }

    function _validateCreateParams(CreateGuaranteeParams calldata p) internal view {
        if (p.beneficiary == address(0)) revert InvalidAddress();
        bytes memory endpoint = bytes(p.endpointUrl);
        if (endpoint.length < 12 || endpoint.length > 512 || !_startsWithHttps(endpoint)) revert InvalidEndpoint();
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
}
