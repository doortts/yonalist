import { useExternalSources } from "../../ExternalSourcesContext";
import { NotesExternalOutlinePane } from "./NotesExternalOutlinePane";
import { NotesOutlinePane } from "./NotesOutlinePane";

const localNotesOutlinePane = <NotesOutlinePane />;

export function NotesDetailPane() {
  const { activeProviderId, pages } = useExternalSources();
  const page = pages.find(
    (candidate) => candidate.providerId === activeProviderId
  );

  return page ? (
    <NotesExternalOutlinePane page={page} />
  ) : (
    localNotesOutlinePane
  );
}
