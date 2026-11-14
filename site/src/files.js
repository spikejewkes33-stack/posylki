// Файлы для отправки: Excel, PDF, резервная копия. Библиотеки грузятся при первом нажатии
// из site/vendor (они в кэше телефона, интернет не нужен).
import { excelSheets, pdfDoc } from './report.js';

const loaded = new Map();
function loadScript(src) {
  if (!loaded.has(src)) {
    loaded.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => {
        loaded.delete(src);
        reject(new Error(`Не загрузилось: ${src}`));
      };
      document.head.append(s);
    }));
  }
  return loaded.get(src);
}

export async function makeXlsx(view) {
  await loadScript('vendor/write-excel-file.min.js');
  return globalThis.writeXlsxFile(excelSheets(view)).toBlob();
}

export async function makePdf(view) {
  await loadScript('vendor/pdfmake.min.js');
  const pdfMake = globalThis.pdfMake;
  const url = (f) => new URL(`vendor/${f}`, location.href).href;
  pdfMake.setFonts({
    Roboto: { normal: url('Roboto-Regular.ttf'), bold: url('Roboto-Medium.ttf'), italics: url('Roboto-Regular.ttf'), bolditalics: url('Roboto-Medium.ttf') },
  });
  pdfMake.setUrlAccessPolicy((u) => new URL(u).origin === location.origin);
  return pdfMake.createPdf(pdfDoc(view)).getBlob();
}

/** Заранее грузит библиотеки, чтобы файл собирался сразу после нажатия. */
export function preloadExports() {
  loadScript('vendor/write-excel-file.min.js').catch(() => {});
  loadScript('vendor/pdfmake.min.js').catch(() => {});
}

/**
 * Отдаёт файл через «Поделиться» (на iPhone: «Сохранить в Файлы», почта, мессенджеры), иначе скачивает.
 * Возвращает 'shared', 'cancelled', 'downloaded' или 'blocked' — телефон не дал открыть «Поделиться»
 * без нового нажатия (файл долго собирался).
 */
export async function shareFile(name, type, content) {
  const file = new File([content], name, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
      if (err.name === 'NotAllowedError') return 'blocked';
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return 'downloaded';
}

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
