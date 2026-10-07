import { useEffect, useState } from "react";

import { captionFeed, type CaptionSnapshot } from "../../lib/studio/caption-feed.js";

/** The shared live transcript (final lines + translations + partial), kept to `lines` final lines. */
export function useCaptionSnapshot(lines: number): CaptionSnapshot {
    const [snap, setSnap] = useState<CaptionSnapshot>(captionFeed.snapshot);
    useEffect(() => {
        captionFeed.keep = lines;
    }, [lines]);
    useEffect(() => captionFeed.subscribe(setSnap), []);
    return snap;
}
