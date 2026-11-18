// The text of an error code of the remote Engine endpoints (Settings → Devices, and "Also update" of the Update dialog). A module of its own, so the
// Update button (loaded with the page) does not pull the Engines settings (a chunk loaded when Settings opens) into the first download.
export function errorLabel(code) {
  return ({
    INVALID_REMOTE_URL: 'Invalid URL format', INVALID_REMOTE_PORT: 'Invalid port', TOKEN_REQUIRED: 'Enter a token',
    REMOTE_TIMEOUT: 'Connection timed out', REMOTE_HTTP_401: 'Token is invalid or has been revoked', REMOTE_ALREADY_EXISTS: 'This remote service is already connected',
    REMOTE_CONNECTION_FAILED: 'Failed to connect to the remote service', REMOTE_URL_MUST_NOT_HAVE_PATH: 'Enter only the scheme and host in the URL, without a path',
    PAIRING_CODE_INVALID: 'Invalid pairing code format', PAIRING_CODE_INVALID_OR_EXPIRED: 'The pairing code is invalid or has expired',
    ENGINE_SCOPE_REQUIRED: 'This connection token has no engine management permission. Use an owner token instead',
    ENGINE_ROUTE_NOT_FOUND: 'The remote engine is too old and needs one manual upgrade first',
    VERSION_URL_NOT_CONFIGURED: 'The remote engine has no version source configured', WORKTREE_DIRTY: 'The remote engine workspace has uncommitted changes',
    BRANCH_DIVERGED: 'The remote engine’s Git branch has diverged', NO_UPDATE_AVAILABLE: 'The remote engine is already up to date',
    UPDATE_IN_PROGRESS: 'The remote engine is running another update', UPDATE_CHECK_FAILED: 'The remote engine failed to check for updates',
    NPM_INSTALLING_FAILED: 'The remote engine failed to install dependencies', NPM_BUILDING_FAILED: 'The remote engine failed to build assets',
    NODE_PTY_LOAD_FAILED: 'The remote engine’s terminal native module check failed',
    DOCKER_MANAGED_UPDATE: 'This engine is managed by Docker. Update the image on the host',
    LAST_DEVICE_VISIBLE: 'At least one device must stay visible',
    INVALID_ENGINE_NAME: 'Enter a name of 1 to 60 characters on one line',
    ENGINE_ADMIN_REQUIRED: 'Only an administrator can rename this machine',
  })[code] || code || 'Operation failed';
}
