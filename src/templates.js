// Función pura: plantilla de Meta → lo que el backoffice necesita para llenarla y enviarla.
// El envío (src/whatsapp.js sendTemplate) usa variables con nombre en el cuerpo ({{nombre}}),
// un sufijo para el botón de URL ({{1}} al final de la URL) y una imagen opcional de encabezado.

const NAMED = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g;
const POSITIONAL = /\{\{\s*\d+\s*\}\}/;

export function templateSpec(t) {
  const components = Array.isArray(t?.components) ? t.components : [];
  const find = (type) => components.find((c) => String(c.type).toUpperCase() === type);
  const header = find('HEADER');
  const body = find('BODY');
  const footer = find('FOOTER');
  const buttons = find('BUTTONS')?.buttons ?? [];
  const urlButton = buttons.find((b) => String(b.type).toUpperCase() === 'URL');
  const bodyText = body?.text ?? '';
  const params = [...new Set([...bodyText.matchAll(NAMED)].map((m) => m[1]))];
  const headerFormat = header ? String(header.format || 'TEXT').toUpperCase() : null;
  const hasUrlSuffix = Boolean(urlButton && /\{\{\s*1\s*\}\}/.test(urlButton.url ?? ''));
  // El envío solo sabe llenar variables con nombre en el cuerpo, y en el encabezado solo una imagen.
  const unsupported = [];
  if (POSITIONAL.test(bodyText)) unsupported.push('usa variables numeradas en el cuerpo ({{1}})');
  if (header && headerFormat === 'TEXT' && /\{\{/.test(header.text ?? '')) unsupported.push('tiene variables en el encabezado');
  if (headerFormat && !['TEXT', 'IMAGE'].includes(headerFormat)) unsupported.push(`encabezado de tipo ${headerFormat.toLowerCase()}`);
  return {
    name: t?.name ?? '',
    language: t?.language ?? 'es_MX',
    category: t?.category ?? null,
    status: t?.status ?? null,
    headerFormat,
    headerText: headerFormat === 'TEXT' ? header?.text ?? null : null,
    bodyText,
    footerText: footer?.text ?? null,
    params,
    urlButton: urlButton ? { text: urlButton.text ?? '', url: urlButton.url ?? '', hasSuffix: hasUrlSuffix } : null,
    needsHeaderImage: headerFormat === 'IMAGE',
    sendable: unsupported.length === 0,
    unsupported,
  };
}

// Texto final que verá el destinatario (vista previa del backoffice).
export function renderTemplate(spec, values = {}) {
  return spec.bodyText.replace(NAMED, (_m, name) => (values[name] ? String(values[name]) : `{{${name}}}`));
}
