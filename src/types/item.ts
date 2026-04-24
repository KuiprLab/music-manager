import type { MBAlbum, MBTrack } from "../utils/musicbrainz.js";

export enum ItemStatus {
    Searching = "searching",
    Ready = "ready",
    Downloading = "downloading",
    Done = "done",
    Failed = "failed",
    Missing = "missing",
}

export const ItemStatusColor: Record<ItemStatus, number> = {
    [ItemStatus.Searching]: 0x3498db,
    [ItemStatus.Ready]: 0x2ecc71,
    [ItemStatus.Downloading]: 0xf1c40f,
    [ItemStatus.Done]: 0x2ecc71,
    [ItemStatus.Failed]: 0xe74c3c,
    [ItemStatus.Missing]: 0x95a5a6,
};

// TODO: support albums
export interface ItemState {
    status: ItemStatus;
    coverUrl: string | undefined,
    error?: string;
    statusMessage?: string;
    data: MBTrack | MBAlbum;
}

