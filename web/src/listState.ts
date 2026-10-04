// Ephemeral UI state only. Material bodies and credentials never enter this cache.
export type MaterialListState = {
  q: string;
  status: string;
  group: string;
  author: string;
  selected: string[];
  limit: number;
  scroll: number;
};
const states = new Map<string, MaterialListState>();
export function materialListKey(
  userId: string,
  workspaceId: string,
  inbox: boolean,
) {
  return JSON.stringify([userId, workspaceId, inbox ? "inbox" : "library"]);
}
export function readMaterialListState(
  key: string,
  inbox: boolean,
): MaterialListState {
  const value = states.get(key);
  return value
    ? { ...value, selected: [...value.selected] }
    : {
        q: "",
        status: inbox ? "unread" : "",
        group: "",
        author: "",
        selected: [],
        limit: 100,
        scroll: 0,
      };
}
export function saveMaterialListState(key: string, value: MaterialListState) {
  states.delete(key);
  states.set(key, { ...value, selected: [...value.selected] });
  if (states.size > 60) states.delete(states.keys().next().value!);
}
export function clearMaterialListStates(userId: string) {
  for (const key of states.keys())
    if ((JSON.parse(key) as string[])[0] === userId) states.delete(key);
}
