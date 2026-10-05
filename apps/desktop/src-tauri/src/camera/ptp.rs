//! PTP container framing and Sony SDIO property parsing. Pure (no I/O), so it
//! is unit-tested and shared by the USB and (later) PTP-IP transports.

pub const OP_GET_DEVICE_INFO: u16 = 0x1001;
pub const OP_OPEN_SESSION: u16 = 0x1002;
pub const OP_CLOSE_SESSION: u16 = 0x1003;
pub const OP_SDIO_CONNECT: u16 = 0x9201;
pub const OP_SDIO_GET_EXT_DEVICE_INFO: u16 = 0x9202;
pub const OP_SDIO_SET_EXT_PROP: u16 = 0x9205;
pub const OP_SDIO_CONTROL_DEVICE: u16 = 0x9207;
pub const OP_SDIO_GET_ALL_EXT_PROP_INFO: u16 = 0x9209;
pub const RESP_OK: u16 = 0x2001;
/// Sony SDIO protocol version the ZV-E10 reports.
pub const SDIO_VERSION: u32 = 300;

pub const CONTAINER_COMMAND: u16 = 1;
pub const CONTAINER_DATA: u16 = 2;
pub const CONTAINER_RESPONSE: u16 = 3;

pub fn container(kind: u16, code: u16, tid: u32, payload: &[u8]) -> Vec<u8> {
    let len = 12 + payload.len() as u32;
    let mut b = Vec::with_capacity(len as usize);
    b.extend(len.to_le_bytes());
    b.extend(kind.to_le_bytes());
    b.extend(code.to_le_bytes());
    b.extend(tid.to_le_bytes());
    b.extend_from_slice(payload);
    b
}

pub fn command(code: u16, tid: u32, params: &[u32]) -> Vec<u8> {
    let p: Vec<u8> = params.iter().flat_map(|v| v.to_le_bytes()).collect();
    container(CONTAINER_COMMAND, code, tid, &p)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub len: u32,
    pub kind: u16,
    pub code: u16,
}

pub fn header(b: &[u8]) -> Option<Header> {
    if b.len() < 12 {
        return None;
    }
    Some(Header {
        len: u32::from_le_bytes([b[0], b[1], b[2], b[3]]),
        kind: u16::from_le_bytes([b[4], b[5]]),
        code: u16::from_le_bytes([b[6], b[7]]),
    })
}

/// Property data types (PTP DTC).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataType {
    I8,
    U8,
    I16,
    U16,
    I32,
    U32,
    I64,
    U64,
    Str,
    Array(u16),
    Other(u16),
}

impl DataType {
    fn from(code: u16) -> Self {
        match code {
            1 => Self::I8,
            2 => Self::U8,
            3 => Self::I16,
            4 => Self::U16,
            5 => Self::I32,
            6 => Self::U32,
            7 => Self::I64,
            8 => Self::U64,
            0xFFFF => Self::Str,
            c if c & 0x4000 != 0 => Self::Array(c & 0x0FFF),
            c => Self::Other(c),
        }
    }

    fn scalar_size(code: u16) -> Option<usize> {
        match code {
            1 | 2 => Some(1),
            3 | 4 => Some(2),
            5 | 6 => Some(4),
            7 | 8 => Some(8),
            _ => None,
        }
    }

    /// Little-endian encoding of an integer value in this type (for Set).
    pub fn encode(self, v: i64) -> Option<Vec<u8>> {
        Some(match self {
            Self::I8 | Self::U8 => vec![v as u8],
            Self::I16 | Self::U16 => (v as u16).to_le_bytes().to_vec(),
            Self::I32 | Self::U32 => (v as u32).to_le_bytes().to_vec(),
            Self::I64 | Self::U64 => (v as u64).to_le_bytes().to_vec(),
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Form {
    None,
    Range {
        min: i64,
        max: i64,
        step: i64,
    },
    /// Values the camera accepts now (Sony's secondary list when present).
    Enum(Vec<i64>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Prop {
    pub code: u16,
    pub dtype: DataType,
    pub writable: bool,
    pub enabled: bool,
    /// Integer value; `None` for strings/arrays.
    pub current: Option<i64>,
    pub text: Option<String>,
    pub form: Form,
}

struct Reader<'a> {
    d: &'a [u8],
    o: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Option<&[u8]> {
        let s = self.d.get(self.o..self.o + n)?;
        self.o += n;
        Some(s)
    }
    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|s| s[0])
    }
    fn u16(&mut self) -> Option<u16> {
        self.take(2).map(|s| u16::from_le_bytes([s[0], s[1]]))
    }
    fn peek_u16(&self) -> Option<u16> {
        let s = self.d.get(self.o..self.o + 2)?;
        Some(u16::from_le_bytes([s[0], s[1]]))
    }
    fn u32(&mut self) -> Option<u32> {
        self.take(4)
            .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }

    /// One value of `code` type: integer, or (None, Some(text)) for strings.
    fn value(&mut self, code: u16) -> Option<(Option<i64>, Option<String>)> {
        if code == 0xFFFF {
            let n = self.u8()? as usize;
            let raw = self.take(2 * n)?;
            let units: Vec<u16> = raw
                .as_chunks::<2>()
                .0
                .iter()
                .map(|c| u16::from_le_bytes(*c))
                .collect();
            let s = String::from_utf16_lossy(&units)
                .trim_end_matches('\0')
                .to_string();
            return Some((None, Some(s)));
        }
        if code & 0x4000 != 0 {
            let n = self.u32()? as usize;
            let size = DataType::scalar_size(code & 0x0FFF).unwrap_or(1);
            self.take(n * size)?;
            return Some((None, None));
        }
        let size = DataType::scalar_size(code)?;
        let s = self.take(size)?;
        let v = match code {
            1 => s[0] as i8 as i64,
            2 => s[0] as i64,
            3 => i16::from_le_bytes([s[0], s[1]]) as i64,
            4 => u16::from_le_bytes([s[0], s[1]]) as i64,
            5 => i32::from_le_bytes([s[0], s[1], s[2], s[3]]) as i64,
            6 => u32::from_le_bytes([s[0], s[1], s[2], s[3]]) as i64,
            7 => i64::from_le_bytes(s.try_into().ok()?),
            8 => u64::from_le_bytes(s.try_into().ok()?) as i64,
            _ => return None,
        };
        Some((Some(v), None))
    }

    fn values(&mut self, code: u16, n: usize) -> Option<Vec<i64>> {
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            out.push(self.value(code)?.0.unwrap_or(0));
        }
        Some(out)
    }
}

/// Parse the SDIO_GetAllExtDevicePropInfo (0x9209) payload.
/// Layout (libgphoto2 ptp_unpack_Sony_DPD, SDIO v300): u64 count, then per
/// prop: code u16, type u16, getset u8, enabled u8, factory, current, form u8,
/// form data, and on newer bodies a second enum list (u16 count < 0x200).
pub fn parse_all_props(d: &[u8]) -> Result<Vec<Prop>, String> {
    let mut r = Reader { d, o: 0 };
    let count = r
        .take(8)
        .map(|s| u64::from_le_bytes(s.try_into().unwrap_or([0; 8])))
        .ok_or("short header")?;
    let mut out = Vec::with_capacity(count as usize);
    for i in 0..count {
        let start = r.o;
        let err = || format!("truncated in prop #{i} (starts at offset {start})");
        let code = r.u16().ok_or_else(err)?;
        let tcode = r.u16().ok_or_else(err)?;
        let getset = r.u8().ok_or_else(err)?;
        let enabled = r.u8().ok_or_else(err)?;
        r.value(tcode).ok_or_else(err)?; // factory default
        let (current, text) = r.value(tcode).ok_or_else(err)?;
        let form_flag = r.u8().ok_or_else(err)?;
        let mut form = match form_flag {
            1 => {
                let v = r.values(tcode, 3).ok_or_else(err)?;
                Form::Range {
                    min: v[0],
                    max: v[1],
                    step: v[2],
                }
            }
            2 => {
                let n = r.u16().ok_or_else(err)? as usize;
                Form::Enum(r.values(tcode, n).ok_or_else(err)?)
            }
            _ => Form::None,
        };
        if form_flag == 2
            && let Some(n2) = r.peek_u16()
            && n2 < 0x200
        {
            r.u16();
            form = Form::Enum(r.values(tcode, n2 as usize).ok_or_else(err)?);
        }
        out.push(Prop {
            code,
            dtype: DataType::from(tcode),
            writable: getset != 0,
            enabled: enabled == 1,
            current,
            text,
            form,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prop_u16_enum(code: u16, cur: u16, primary: &[u16], secondary: Option<&[u16]>) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend(code.to_le_bytes());
        b.extend(4u16.to_le_bytes());
        b.push(1);
        b.push(1);
        b.extend(0u16.to_le_bytes());
        b.extend(cur.to_le_bytes());
        b.push(2);
        b.extend((primary.len() as u16).to_le_bytes());
        for v in primary {
            b.extend(v.to_le_bytes());
        }
        if let Some(s) = secondary {
            b.extend((s.len() as u16).to_le_bytes());
            for v in s {
                b.extend(v.to_le_bytes());
            }
        }
        b
    }

    #[test]
    fn command_container_layout() {
        let c = command(OP_OPEN_SESSION, 1, &[1]);
        assert_eq!(c.len(), 16);
        assert_eq!(
            header(&c),
            Some(Header {
                len: 16,
                kind: 1,
                code: 0x1002
            })
        );
        assert_eq!(&c[12..], &1u32.to_le_bytes());
    }

    #[test]
    fn parses_enum_with_secondary_list_range_and_signed() {
        let mut d = 3u64.to_le_bytes().to_vec();
        d.extend(prop_u16_enum(0x5005, 2, &[2, 4], Some(&[2, 4, 0x8011])));
        // INT8 range prop (ZoomOperation-like), form range -1..1 step 1
        d.extend(0xD2DDu16.to_le_bytes());
        d.extend(1u16.to_le_bytes());
        d.extend([1, 1, 0, 0xFF, 1, 0xFF, 1, 1]);
        // string prop, no form
        d.extend(0xD223u16.to_le_bytes());
        d.extend(0xFFFFu16.to_le_bytes());
        d.extend([1, 1, 0, 2, b'a', 0, 0, 0, 0]);
        let props = parse_all_props(&d).expect("parse");
        assert_eq!(props.len(), 3);
        assert_eq!(props[0].form, Form::Enum(vec![2, 4, 0x8011]));
        assert_eq!(props[1].current, Some(-1));
        assert_eq!(
            props[1].form,
            Form::Range {
                min: -1,
                max: 1,
                step: 1
            }
        );
        assert_eq!(props[2].text.as_deref(), Some("a"));
        assert_eq!(props[2].dtype, DataType::Str);
    }

    #[test]
    fn enum_without_secondary_list_keeps_next_prop_aligned() {
        let mut d = 2u64.to_le_bytes().to_vec();
        d.extend(prop_u16_enum(0x500A, 0x8004, &[2, 0x8004], None));
        d.extend(prop_u16_enum(0x500B, 0x8002, &[0x8001, 0x8002], None));
        let props = parse_all_props(&d).expect("parse");
        assert_eq!(props[1].code, 0x500B);
        assert_eq!(props[1].current, Some(0x8002));
    }

    #[test]
    fn truncated_payload_is_an_error_not_a_panic() {
        let mut d = 1u64.to_le_bytes().to_vec();
        d.extend([0x05, 0x50, 0x04]);
        assert!(parse_all_props(&d).is_err());
    }

    #[test]
    fn encodes_values_by_type() {
        assert_eq!(DataType::I8.encode(-1), Some(vec![0xFF]));
        assert_eq!(DataType::U16.encode(0x8004), Some(vec![0x04, 0x80]));
        assert_eq!(DataType::U32.encode(0x320), Some(vec![0x20, 0x03, 0, 0]));
        assert_eq!(DataType::Str.encode(1), None);
    }
}
