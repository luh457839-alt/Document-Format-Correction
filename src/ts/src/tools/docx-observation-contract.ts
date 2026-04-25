import type { DocumentNodeStyle } from "../core/types.js";
import type { DocumentState, TextRunStyle } from "./docx-observation-tool.js";
import type { PythonDocxObservationState } from "./python-tool-client.js";

type Assert<T extends true> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;

type _DocumentStateMatchesPythonObservation = Assert<IsAssignable<DocumentState, PythonDocxObservationState>>;
type _TextRunStyleMatchesDocumentNodeStyle = Assert<IsAssignable<TextRunStyle, DocumentNodeStyle>>;

export {};
