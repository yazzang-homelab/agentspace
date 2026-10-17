import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const DEFAULT_PROFILE = { id: "Default", name: "Personal" };

/** agentspace profiles: each one is a separate Chromium user-data-dir. */
export class ProfileStore {
  #file;
  #state;

  constructor(file) {
    this.#file = file;
    this.#state = this.#load();
  }

  #load() {
    if (existsSync(this.#file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.#file, "utf8"));
        if (Array.isArray(parsed.profiles) && parsed.profiles.length > 0) return parsed;
      } catch {}
    }
    return { profiles: [{ ...DEFAULT_PROFILE }], defaultId: DEFAULT_PROFILE.id };
  }

  save() {
    const temp = `${this.#file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.#state, null, 2), { mode: 0o600 });
    renameSync(temp, this.#file);
  }

  list() {
    return this.#state.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      isDefault: profile.id === this.#state.defaultId,
    }));
  }

  get defaultId() {
    return this.#state.defaultId;
  }

  /** Resolve a createTaskSpace profile locator; undefined when unknown. */
  resolve(profileId) {
    if (profileId === undefined || profileId === "" || profileId === "default") {
      return this.get(this.#state.defaultId);
    }
    return this.get(profileId);
  }

  get(id) {
    return this.#state.profiles.find((profile) => profile.id === id);
  }

  nextId() {
    let index = 1;
    const ids = new Set(this.#state.profiles.map((profile) => profile.id));
    while (ids.has(`Profile ${index}`)) index += 1;
    return `Profile ${index}`;
  }

  add(profile) {
    this.#state.profiles.push({ id: profile.id, name: profile.name });
    this.save();
  }

  replaceAll(profiles, defaultId) {
    this.#state = { profiles, defaultId };
    this.save();
  }

  setDefault(id) {
    if (!this.get(id)) throw new Error(`Profile not found: ${id}`);
    this.#state.defaultId = id;
    this.save();
  }
}
