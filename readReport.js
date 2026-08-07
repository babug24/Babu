const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
(async () => {
  const reportDir = path.resolve(__dirname, 'report');
  const files = fs.readdirSync(reportDir).filter(f => f.startsWith('FundSectionAvailability') && f.endsWith('.xlsx'));
  if (files.length === 0) {
    throw new Error('No report files found');
  }
  const latest = files
    .map(f => ({ file: f, mtime: fs.statSync(path.join(reportDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].file;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.join(reportDir, latest));
  console.log('Reading', latest);
  const sheet = workbook.getWorksheet(1);
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const values = row.values.slice(1);
    if (rowNumber === 1) console.log('HEADER', values);
    else console.log('ROW', values);
  });
})();
