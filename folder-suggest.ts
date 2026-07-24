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
    const out: TFolder[] = [];
    for (const f of this.appRef.vault.getAllLoadedFiles()) {
      if (f instanceof TFolder && f.path.toLowerCase().includes(q)) out.push(f);
    }
    return out.slice(0, 100);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path === "/" ? "/" : folder.path);
  }
}
