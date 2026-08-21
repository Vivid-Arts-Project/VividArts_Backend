const createRealtimeNotificationHub = () => {
  const subscribers = new Map();

  const keyFor = (type, userId) => `${String(type)}:${String(userId)}`;

  return {
    subscribe({ type, userId, listener }) {
      if (!type || !userId || typeof listener !== 'function') {
        throw new Error('Realtime notification subscription requires type, userId, and listener.');
      }

      const key = keyFor(type, userId);
      const listeners = subscribers.get(key) || new Set();
      listeners.add(listener);
      subscribers.set(key, listeners);

      return () => {
        const current = subscribers.get(key);
        if (!current) return;
        current.delete(listener);
        if (!current.size) subscribers.delete(key);
      };
    },
    emit({ type, userId, event }) {
      if (!type || userId == null) return 0;

      const key = keyFor(type, userId);
      const listeners = subscribers.get(key);
      if (!listeners || !listeners.size) return 0;

      let delivered = 0;
      for (const listener of [...listeners]) {
        try {
          listener(event);
          delivered += 1;
        } catch (error) {
          console.error('[realtime-notification] listener failed:', error);
        }
      }

      return delivered;
    },
    count(type, userId) {
      if (!type || userId == null) return 0;
      return subscribers.get(keyFor(type, userId))?.size || 0;
    },
    clear() {
      subscribers.clear();
    },
  };
};

const realtimeNotificationHub = createRealtimeNotificationHub();

const emitRealtimeNotification = ({ hub = realtimeNotificationHub, type, userId, event }) => {
  if (!type || userId == null) return 0;
  return hub.emit({ type, userId, event });
};

module.exports = {
  createRealtimeNotificationHub,
  realtimeNotificationHub,
  emitRealtimeNotification,
};
