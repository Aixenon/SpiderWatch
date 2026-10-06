// Share lifecycle reads, but reconcile once more after an in-flight mutation.
export function createPanelRefresh(read, {enabled = () => true, now = () => Date.now(), reuseMs = 1000} = {}) {
  let pending = null, followup = false, version = 0, readingVersion = null, completedAt = -Infinity;
  function invalidate() { version++; completedAt = -Infinity; }
  function load(fresh = false) {
    if (!enabled()) return Promise.resolve(false);
    if (pending) {
      if (readingVersion !== null && (fresh || readingVersion !== version)) followup = true;
      return pending;
    }
    if (!fresh && now() - completedAt < reuseMs) return Promise.resolve(true);
    // Defer the read so simultaneous route/visibility/socket events share it.
    pending = Promise.resolve().then(async () => {
      let loaded = false;
      try {
        do {
          followup = false;
          if (!enabled()) return false;
          readingVersion = version;
          completedAt = -Infinity;
          loaded = await read();
          completedAt = loaded && readingVersion === version ? now() : -Infinity;
        } while (followup && enabled());
        return loaded;
      } finally { pending = null; readingVersion = null; }
    });
    return pending;
  }
  return {load, invalidate};
}
