import type { FileSearchResponse } from "../soulseek-ts/messages/from/peer.js";
// ─── Pending state ────────────────────────────────────────────────────────────

export type PendingEntry = {
    result: FileSearchResponse;
    fileIndex: number;
};


// PendingItem Class

export class PendingItem {
    static pendingResults = new Map<string, PendingEntry[]>();

    private constructor() { }


    public static getPendingResult(
        storeKey: string,
        index: number,
    ): PendingEntry | undefined {
        return PendingItem.pendingResults.get(storeKey)?.[index];
    }

    public static getPendingResults(
        storeKey: string,
    ): PendingEntry[] | undefined {
        return PendingItem.pendingResults.get(storeKey);
    }

}




