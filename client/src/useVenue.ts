// The Bar Games venue context (null standalone). Keeps the venue's theme applied on a box.
import { useVenue as kitUseVenue } from "@bargames/gamekit/client";
import type { VenueContext } from "@bargames/sdk/client";

export const useVenue = (): VenueContext | null => kitUseVenue(undefined);
