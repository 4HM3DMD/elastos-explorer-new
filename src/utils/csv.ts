export function downloadCSV(filename: string, headers: string[], rows: string[][]): void {
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const escape = (val: string) => {
    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  };

  const lines = [
    headers.map(escape).join(','),
    ...rows.map(row => row.map(escape).join(',')),
  ];

  const BOM = '\uFEFF';
  const blob = new Blob([BOM + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safeFilename;
  link.click();
  URL.revokeObjectURL(url);
}
