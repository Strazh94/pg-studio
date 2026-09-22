import type { QueryColumn } from '../../shared/types';
import { displayCell, shortText } from '../lib/format';

interface Props {
  columns: QueryColumn[];
  rows: unknown[][];
  startRow?: number;
}

/** Read-only сетка результатов SQL-запроса. */
export default function ResultTable({ columns, rows, startRow = 0 }: Props) {
  if (columns.length === 0) return null;
  return (
    <div className="grid-wrap">
      <table className="data-grid result-grid">
        <thead>
          <tr>
            <th className="rownum">#</th>
            {columns.map((column, index) => (
              <th key={`${column.name}-${index}`}>
                <div className="col-name">{column.name}</div>
                {column.type && <div className="col-type">{column.type}</div>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              <td className="rownum">{startRow + rowIndex + 1}</td>
              {row.map((value, cellIndex) => {
                const text = displayCell(value);
                return (
                  <td
                    key={cellIndex}
                    className={value === null || value === undefined ? 'null-cell' : ''}
                  >
                    <span title={text}>{shortText(text)}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
