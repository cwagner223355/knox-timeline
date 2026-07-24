import { AbstractInputSuggest, App, TFolder } from "obsidian";

/**
 * Attaches vault-folder autocomplete to a text input. Suggests any folder whose
 * path contains the typed query; pass an onSelect callback to persist the pick.
 */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  private readonly appRef: App;

  constructor(app: App, textInputEl: HTMLInputElement) {
    super(app, textInputEl);
    this.appRef = app;
  }

  protected getSuggestions(query: string): TFolder[] {
    const q = query.toLowerCase();
    // Enumerate folders only (not every file) to keep the plugin's vault access
    // narrow: this powers folder autocomplete and needs nothing else.
    return this.appRef.vault
      .getAllFolders(true)
      .filter((f) => f.path.toLowerCase().includes(q))
      .slice(0, 100);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path === "/" ? "/" : folder.path);
  }
}
