import { useCallback, useState } from "react";
import {
  listSecretFiles,
  listSecrets,
  getSecret,
  upsertSecret,
} from "./configRpcClient";

type LoadingState = "idle" | "loading" | "error";

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface SecretEntry {
  name: string;
  file: string;
}

export function useSecrets(
  configToolUrl: string,
  privilegeGrantId: string,
  conversationId: string,
  authToken?: string,
) {
  const [secretFilesState, setSecretFilesState] = useState<LoadingState>("idle");
  const [secretsState, setSecretsState] = useState<LoadingState>("idle");
  const [upsertState, setUpsertState] = useState<LoadingState>("idle");

  const [secretFilesError, setSecretFilesError] = useState<string | null>(null);
  const [secretsError, setSecretsError] = useState<string | null>(null);
  const [upsertError, setUpsertError] = useState<string | null>(null);

  const [secretFiles, setSecretFiles] = useState<Array<{ name: string }>>([]);
  const [secrets, setSecrets] = useState<SecretEntry[]>([]);

  const loadSecretFiles = useCallback(async () => {
    if (!privilegeGrantId || !conversationId) return;
    setSecretFilesState("loading");
    setSecretFilesError(null);
    try {
      const data = await listSecretFiles(
        configToolUrl,
        privilegeGrantId,
        conversationId,
        authToken,
      );
      setSecretFiles(data);
      setSecretFilesState("idle");
    } catch (err) {
      setSecretFilesError(toErrorMessage(err));
      setSecretFilesState("error");
    }
  }, [configToolUrl, privilegeGrantId, conversationId, authToken]);

  const loadSecrets = useCallback(async () => {
    if (!privilegeGrantId || !conversationId) return;
    setSecretsState("loading");
    setSecretsError(null);
    try {
      const data = await listSecrets(
        configToolUrl,
        privilegeGrantId,
        conversationId,
        authToken,
      );
      setSecrets(data);
      setSecretsState("idle");
    } catch (err) {
      setSecretsError(toErrorMessage(err));
      setSecretsState("error");
    }
  }, [configToolUrl, privilegeGrantId, conversationId, authToken]);

  const revealSecret = useCallback(
    async (name: string): Promise<string | null> => {
      if (!privilegeGrantId || !conversationId) return null;
      try {
        const result = await getSecret(
          configToolUrl,
          name,
          privilegeGrantId,
          conversationId,
          authToken,
        );
        return result.value;
      } catch {
        return null;
      }
    },
    [configToolUrl, privilegeGrantId, conversationId, authToken],
  );

  const saveSecret = useCallback(
    async (file: string, name: string, value: string): Promise<boolean> => {
      if (!privilegeGrantId || !conversationId) return false;
      setUpsertState("loading");
      setUpsertError(null);
      try {
        await upsertSecret(
          configToolUrl,
          file,
          name,
          value,
          privilegeGrantId,
          conversationId,
          authToken,
        );
        setUpsertState("idle");
        // Reload the secrets list
        await loadSecrets();
        return true;
      } catch (err) {
        setUpsertError(toErrorMessage(err));
        setUpsertState("error");
        return false;
      }
    },
    [configToolUrl, privilegeGrantId, conversationId, authToken, loadSecrets],
  );

  return {
    secretFilesState,
    secretsState,
    upsertState,
    secretFilesError,
    secretsError,
    upsertError,
    secretFiles,
    secrets,
    loadSecretFiles,
    loadSecrets,
    revealSecret,
    saveSecret,
  };
}
