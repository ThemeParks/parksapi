import {describe, it, expect, vi} from 'vitest';
import {Phantasialand} from '../phantasialand.js';

/**
 * The opening-hours page is a Next.js page. Its calendar is not in the markup
 * but in the data stream the page hands to the browser, as lines of the form
 * `<id>:<json>` spread over `self.__next_f.push([1,"<text>"])` calls.
 */
const CALENDAR = {
  calendarData: [
    {labelId: 'a', ranges: [{startDay: '2026-12-30', endDay: '2027-01-02'}]},
    {labelId: 'b', ranges: [{startDay: '2027-01-05', endDay: '2027-01-05'}, {startDay: '2026-12-24', endDay: '2026-12-25'}]},
  ],
  colorLegendLabels: [
    {id: 'a', labelName: 'Wintertraum: 11 a.m. – 08 p.m.'},
    {id: 'b', labelName: 'Theme park closed'},
    {id: 'c', labelName: 'Subject to changes.'},
  ],
};

/** A page whose stream holds the calendar block on one line, spread over `calls` push calls. */
function page(calendar: unknown, calls = 1): string {
  const line = `b:${JSON.stringify([{data: {blockType: 'calendar-block', calendar}}])}\n`;
  const size = Math.ceil(line.length / calls);
  let html = '<html><body>';
  for (let at = 0; at < line.length; at += size) {
    html += `<script>self.__next_f.push([1,${JSON.stringify(line.slice(at, at + size))}])</script>`;
  }
  return `${html}</body></html>`;
}

describe('Phantasialand calendar', () => {
  const park = new Phantasialand();

  it('builds one event per legend label with every day of its ranges', () => {
    const expected = [
      {title: 'Wintertraum: 11 a.m. – 08 p.m.', days_selected: ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']},
      {title: 'Theme park closed', days_selected: ['2027-01-05', '2026-12-24', '2026-12-25']},
      {title: 'Subject to changes.', days_selected: []},
    ];
    expect(park.parseCalendar(page(CALENDAR))).toEqual(expected);
    expect(park.parseCalendar(page(CALENDAR, 3))).toEqual(expected);
  });

  it('returns an empty list when the calendar is missing or unreadable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(park.parseCalendar('<html></html>')).toEqual([]);
    const broken = '<script>self.__next_f.push([1,"b:{\\"blockType\\":\\"calendar-block\\" x\\n"])</script>';
    expect(park.parseCalendar(broken)).toEqual([]);
    expect(park.parseCalendar(page({calendarData: {}, colorLegendLabels: []}))).toEqual([]);
    warn.mockRestore();
  });

  it('reads 12h titles with "until" and with a dash, and 24h titles', () => {
    const hours = (title: string) => (park as any).parseHours(title);
    expect(hours('Park opened: 09 a.m. until 06 p.m.')).toEqual({open: '09:00', close: '18:00'});
    expect(hours('Wintertraum: 11 a.m. – 08 p.m.')).toEqual({open: '11:00', close: '20:00'});
    expect(hours("New Year's eve 11 a.m. - 06 p.m.")).toEqual({open: '11:00', close: '18:00'});
    expect(hours('09 a.m. until 11 a.m.')).toEqual({open: '09:00', close: '11:00'});
    expect(hours('12 p.m. until 08 p.m.')).toEqual({open: '12:00', close: '20:00'});
    expect(hours('Parköffnung: 09:00 – 18:00 Uhr')).toEqual({open: '09:00', close: '18:00'});
    expect(hours('Opening of the attractions from 10 a.m.')).toBeNull();
  });

  it('turns the calendar into schedule entries, closed days left out', async () => {
    vi.spyOn(park as any, 'getCalendarJSON').mockResolvedValue(park.parseCalendar(page(CALENDAR)));
    vi.spyOn(park as any, 'getParkInfos').mockResolvedValue(null);
    const [entry] = await (park as any).buildSchedules();
    expect(entry.schedule.map((day: any) => day.date)).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
    expect(entry.schedule[0].openingTime).toBe('2026-12-30T11:00:00+01:00');
    expect(entry.schedule[0].closingTime).toBe('2026-12-30T20:00:00+01:00');
  });
});
