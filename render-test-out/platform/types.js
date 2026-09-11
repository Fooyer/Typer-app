"use strict";
// Tipos que antes viviam em `electron/*.ts` (processo principal) e eram importados pelo front-end
// só pela assinatura (type-only). Como o backend agora é Rust, este arquivo é a única fonte da
// verdade dessas formas para o front-end — devem ficar em sincronia com as structs `#[derive(Serialize)]`
// equivalentes em `src-tauri/src/*.rs` conforme cada uma for implementada.
Object.defineProperty(exports, "__esModule", { value: true });
