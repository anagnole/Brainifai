import { useCallback } from 'react';

interface Props {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}

export function TimeSlider({ from, to, onChange }: Props) {
  const handleFromChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange(e.target.value, to);
    },
    [to, onChange],
  );

  const handleToChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange(from, e.target.value);
    },
    [from, onChange],
  );

  return (
    <div className="time-slider">
      <input type="date" value={from} onChange={handleFromChange} />
      <input type="date" value={to} onChange={handleToChange} />
    </div>
  );
}
