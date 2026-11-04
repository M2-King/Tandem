import { useCallback, useEffect, useState } from 'react';

// Connection state of the local runtime and what it reports about the
// project and its interpreter. Refreshed whenever the connection comes back.
export function useRuntimeStatus(backend) {
  const [connection, setConnection] = useState(backend?.client.state ?? 'demo');
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!backend) return;
    try {
      setStatus(await backend.status());
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [backend]);

  useEffect(() => {
    if (!backend) return undefined;
    refresh();
    const off = backend.client.onState((state) => {
      setConnection(state);
      if (state === 'connected') refresh();
    });
    // The socket may have opened before this subscription: catch up.
    setConnection(backend.client.state);
    return off;
  }, [backend, refresh]);

  return { connection, status, error, refresh };
}
