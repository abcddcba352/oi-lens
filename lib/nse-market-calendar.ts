export type MarketDayState = 'holiday' | 'weekend' | 'eod-current' | 'awaiting-eod' | 'eod-missing';

export interface MarketDayStatus {
  today: string;
  state: MarketDayState;
  title: string;
  detail: string;
  latestEodDate: string | null;
  collectionRequired: boolean;
  holidayName: string | null;
}

// NSE F&O trading holidays published in circular NSE/FAOP/71777.
// Weekend holidays are handled by weekday detection instead of duplicating them here.
export const NSE_FO_HOLIDAYS_2026: Readonly<Record<string, string>> = {
  '2026-01-26': 'Republic Day',
  '2026-03-03': 'Holi',
  '2026-03-26': 'Shri Ram Navami',
  '2026-03-31': 'Shri Mahavir Jayanti',
  '2026-04-03': 'Good Friday',
  '2026-04-14': 'Dr. Baba Saheb Ambedkar Jayanti',
  '2026-05-01': 'Maharashtra Day',
  '2026-05-28': 'Bakri Id',
  '2026-06-26': 'Muharram',
  '2026-09-14': 'Ganesh Chaturthi',
  '2026-10-02': 'Mahatma Gandhi Jayanti',
  '2026-10-20': 'Dussehra',
  '2026-11-10': 'Diwali-Balipratipada',
  '2026-11-24': 'Prakash Gurpurb Sri Guru Nanak Dev',
  '2026-12-25': 'Christmas',
};

function istParts(now: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '';
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    weekday: value('weekday'),
    minutes: Number(value('hour')) * 60 + Number(value('minute')),
  };
}

export function buildMarketDayStatus(now: Date, latestEodDate: string | null): MarketDayStatus {
  const today = istParts(now);
  const holidayName = NSE_FO_HOLIDAYS_2026[today.date] ?? null;
  const base = { today: today.date, latestEodDate, holidayName };

  if (holidayName) {
    return {
      ...base,
      state: 'holiday',
      title: `Market closed today — ${holidayName}`,
      detail: 'NSE has no regular equity or F&O session today. No EOD report needs to be collected.',
      collectionRequired: false,
    };
  }
  if (today.weekday === 'Sat' || today.weekday === 'Sun') {
    return {
      ...base,
      state: 'weekend',
      title: 'Market closed today — weekend',
      detail: 'There is no regular NSE session today. No EOD report needs to be collected.',
      collectionRequired: false,
    };
  }
  if (latestEodDate === today.date) {
    return {
      ...base,
      state: 'eod-current',
      title: 'Today’s EOD report is stored',
      detail: 'The latest official session is already available. No additional EOD collection is required.',
      collectionRequired: false,
    };
  }
  if (today.minutes < 18 * 60 + 30) {
    return {
      ...base,
      state: 'awaiting-eod',
      title: 'Today’s EOD report is not due yet',
      detail: 'Wait until after 18:30 IST for NSE’s final files. The database is current through the previous trading session.',
      collectionRequired: false,
    };
  }
  return {
    ...base,
    state: 'eod-missing',
    title: 'Today’s EOD report is pending',
    detail: 'The market traded today and the final EOD session has not been stored. Run or inspect the daily update.',
    collectionRequired: true,
  };
}
