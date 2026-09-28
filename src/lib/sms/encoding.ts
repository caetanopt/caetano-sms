const GSM_BASIC = new Set(
  Array.from(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
  ),
);

const GSM_EXTENSION = new Set(Array.from("^{}\\[~]|€"));

export type SmsSegmentInfo = {
  encoding: "GSM_7" | "UCS_2";
  characters: number;
  units: number;
  segments: number;
  remainingInSegment: number;
};

export function getSmsSegmentInfo(message: string): SmsSegmentInfo {
  let gsmUnits = 0;
  let isGsm = true;

  for (const char of message) {
    if (GSM_BASIC.has(char)) gsmUnits += 1;
    else if (GSM_EXTENSION.has(char)) gsmUnits += 2;
    else {
      isGsm = false;
      break;
    }
  }

  if (isGsm) {
    const segmentSize = gsmUnits <= 160 ? 160 : 153;
    const segments = Math.max(1, Math.ceil(gsmUnits / segmentSize));
    const remainingInSegment = Math.max(0, segments * segmentSize - gsmUnits);
    return {
      encoding: "GSM_7",
      characters: Array.from(message).length,
      units: gsmUnits,
      segments,
      remainingInSegment,
    };
  }

  const units = Array.from(message).length;
  const segmentSize = units <= 70 ? 70 : 67;
  const segments = Math.max(1, Math.ceil(units / segmentSize));
  const remainingInSegment = Math.max(0, segments * segmentSize - units);
  return {
    encoding: "UCS_2",
    characters: units,
    units,
    segments,
    remainingInSegment,
  };
}

export function assertSmsLength(message: string) {
  const info = getSmsSegmentInfo(message);
  const maxUnits = info.encoding === "GSM_7" ? 1530 : 630;
  if (info.units > maxUnits) {
    throw new Error(`Mensagem demasiado longa para SMS (${info.units}/${maxUnits})`);
  }
  return info;
}
