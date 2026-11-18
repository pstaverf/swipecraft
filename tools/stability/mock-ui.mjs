export const ui = {
  shown: [],
  answers: [],
};

export const answer = (value) => {
  ui.answers.push(value);
};

export const reset = () => {
  ui.shown.length = 0;
  ui.answers.length = 0;
};

export const FormCancelationReason = { UserBusy: "UserBusy", UserClosed: "UserClosed" };
export const FormResponseMode = { Modal: "modal", Action: "buttons", Message: "message" };

const fill = (record, values) =>
  values.map((value, index) => {
    const control = record.controls[index];
    if (!control) return value;
    if (control.type === "dropdown" && typeof value === "number") return (control.options ?? [])[value] ?? String(value);
    if (control.type === "slider" && typeof value === "string" && value.length > 0) return Number(value);
    return value;
  });

const next = (record) => {
  ui.shown.push(record);
  if (ui.answers.length === 0) return { canceled: true, cancelationReason: FormCancelationReason.UserClosed };
  let value = ui.answers.shift();
  if (typeof value === "function") value = value(record);
  if (value === undefined || value === "cancel") return { canceled: true, cancelationReason: FormCancelationReason.UserClosed };
  if (typeof value === "number") return { canceled: false, selection: value, response: undefined };
  if (Array.isArray(value)) return { canceled: false, formValues: fill(record, value), selection: undefined };
  return { canceled: false, ...value };
};

class BaseForm {
  constructor(kind) {
    this.kind = kind;
    this.titleText = "";
    this.bodyText = "";
    this.buttons = [];
    this.controls = [];
    this.submitLabel = "";
  }
  title(value) {
    this.titleText = String(value ?? "");
    return this;
  }
  body(value) {
    this.bodyText = String(value ?? "");
    return this;
  }
  button(label) {
    this.buttons.push(String(label ?? ""));
    return this;
  }
  textField(label, placeholder, options) {
    this.controls.push({ type: "textField", label: String(label ?? ""), placeholder, options });
    return this;
  }
  dropdown(label, options, config) {
    this.controls.push({ type: "dropdown", label: String(label ?? ""), options: [...(options ?? [])], config });
    return this;
  }
  slider(label, min, max, config) {
    this.controls.push({ type: "slider", label: String(label ?? ""), min, max, config });
    return this;
  }
  toggle(label, config) {
    this.controls.push({ type: "toggle", label: String(label ?? ""), config });
    return this;
  }
  submitButton(label) {
    this.submitLabel = String(label ?? "");
    return this;
  }
  footer(value) {
    this.footerText = String(value ?? "");
    return this;
  }
  async show(player) {
    const record = {
      kind: this.kind,
      player: player?.name,
      title: this.titleText,
      body: this.bodyText,
      buttons: [...this.buttons],
      controls: this.controls.map((row) => ({ ...row })),
    };
    const response = next(record);
    if (process.env.UI_TRACE) console.log(`[ui] ${record.kind} «${record.title}» -> sel=${response.selection} vals=${JSON.stringify(response.formValues ?? null)}`);
    return {
      ...response,
      display: () => response,
    };
  }
}

export class ActionFormData extends BaseForm {
  constructor() {
    super("action");
  }
}

export class ModalFormData extends BaseForm {
  constructor() {
    super("modal");
  }
}

export class MessageFormData extends BaseForm {
  constructor() {
    super("message");
  }
  button1(label) {
    this.buttons[0] = String(label ?? "");
    return this;
  }
  button2(label) {
    this.buttons[1] = String(label ?? "");
    return this;
  }
}

export const lastShown = () => ui.shown[ui.shown.length - 1];
export const shownTitles = () => ui.shown.map((row) => `${row.kind}:${row.title}`);
