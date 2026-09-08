declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { shared?: boolean; wsProtocols?: string[] });
    scaleViewport: boolean;
    resizeSession: boolean;
    focusOnClick: boolean;
    viewOnly: boolean;
    showDotCursor: boolean;
    background: string;
    disconnect(): void;
    focus(options?: FocusOptions): void;
    blur(): void;
    sendKey(keysym: number, code?: string | null, down?: boolean): void;
    clipboardPasteFrom(text: string): void;
    toDataURL(type?: string, quality?: number): string;
  }
}
