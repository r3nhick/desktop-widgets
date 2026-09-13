const WARNING_INTERVAL_MS = 5 * 60 * 1000;
const warningTimes = new Map();
let logger = null;

export function configureLogger(value) {
  logger = value;
};

export function warn(key, message) {
  const now = Date.now();
  const lastWarning = warningTimes.get(key) ?? 0;

  if (now - lastWarning < WARNING_INTERVAL_MS) {
    return;
  };

  warningTimes.set(key, now);

  if (logger) {
    logger.warn(message);
  } else {
    console.warn(message);
  };
};

export function resetLogger() {
  logger = null;
  warningTimes.clear();
};
