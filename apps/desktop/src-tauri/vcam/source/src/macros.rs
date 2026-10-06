//! Delegation boilerplate shared by the activator, the source and the stream.
//!
//! Each COM object owns an `IMFAttributes` store created by
//! `MFCreateAttributes` and an `IMFMediaEventQueue` created by
//! `MFCreateEventQueue`; the interface methods simply forward to them.

/// Implements `IMFAttributes_Impl` for `$ty` by forwarding every call to the
/// `IMFAttributes` in field `$field`. Methods whose safe wrapper takes a
/// different shape (slices, `Param`) call the vtable directly so the raw
/// arguments pass through untouched.
macro_rules! forward_attributes {
    ($ty:ty, $field:ident) => {
        impl ::windows::Win32::Media::MediaFoundation::IMFAttributes_Impl for $ty {
            fn GetItem(
                &self,
                key: *const ::windows_core::GUID,
                value: *mut ::windows::Win32::System::Com::StructuredStorage::PROPVARIANT,
            ) -> ::windows_core::Result<()> {
                unsafe { self.$field.GetItem(key, (!value.is_null()).then_some(value)) }
            }

            fn GetItemType(
                &self,
                key: *const ::windows_core::GUID,
            ) -> ::windows_core::Result<::windows::Win32::Media::MediaFoundation::MF_ATTRIBUTE_TYPE> {
                unsafe { self.$field.GetItemType(key) }
            }

            fn CompareItem(
                &self,
                key: *const ::windows_core::GUID,
                value: *const ::windows::Win32::System::Com::StructuredStorage::PROPVARIANT,
            ) -> ::windows_core::Result<::windows_core::BOOL> {
                unsafe { self.$field.CompareItem(key, value) }
            }

            fn Compare(
                &self,
                theirs: ::windows_core::Ref<'_, ::windows::Win32::Media::MediaFoundation::IMFAttributes>,
                match_type: ::windows::Win32::Media::MediaFoundation::MF_ATTRIBUTES_MATCH_TYPE,
            ) -> ::windows_core::Result<::windows_core::BOOL> {
                unsafe { self.$field.Compare(theirs.as_ref(), match_type) }
            }

            fn GetUINT32(&self, key: *const ::windows_core::GUID) -> ::windows_core::Result<u32> {
                unsafe { self.$field.GetUINT32(key) }
            }

            fn GetUINT64(&self, key: *const ::windows_core::GUID) -> ::windows_core::Result<u64> {
                unsafe { self.$field.GetUINT64(key) }
            }

            fn GetDouble(&self, key: *const ::windows_core::GUID) -> ::windows_core::Result<f64> {
                unsafe { self.$field.GetDouble(key) }
            }

            fn GetGUID(&self, key: *const ::windows_core::GUID) -> ::windows_core::Result<::windows_core::GUID> {
                unsafe { self.$field.GetGUID(key) }
            }

            fn GetStringLength(&self, key: *const ::windows_core::GUID) -> ::windows_core::Result<u32> {
                unsafe { self.$field.GetStringLength(key) }
            }

            fn GetString(
                &self,
                key: *const ::windows_core::GUID,
                buffer: ::windows_core::PWSTR,
                size: u32,
                length: *mut u32,
            ) -> ::windows_core::Result<()> {
                let inner = &self.$field;
                unsafe {
                    (::windows_core::Interface::vtable(inner).GetString)(
                        ::windows_core::Interface::as_raw(inner),
                        key,
                        buffer,
                        size,
                        length,
                    )
                    .ok()
                }
            }

            fn GetAllocatedString(
                &self,
                key: *const ::windows_core::GUID,
                value: *mut ::windows_core::PWSTR,
                length: *mut u32,
            ) -> ::windows_core::Result<()> {
                unsafe { self.$field.GetAllocatedString(key, value, length) }
            }

            fn GetBlobSize(&self, key: *const ::windows_core::GUID) -> ::windows_core::Result<u32> {
                unsafe { self.$field.GetBlobSize(key) }
            }

            fn GetBlob(
                &self,
                key: *const ::windows_core::GUID,
                buffer: *mut u8,
                size: u32,
                written: *mut u32,
            ) -> ::windows_core::Result<()> {
                let inner = &self.$field;
                unsafe {
                    (::windows_core::Interface::vtable(inner).GetBlob)(
                        ::windows_core::Interface::as_raw(inner),
                        key,
                        buffer,
                        size,
                        written,
                    )
                    .ok()
                }
            }

            fn GetAllocatedBlob(
                &self,
                key: *const ::windows_core::GUID,
                buffer: *mut *mut u8,
                size: *mut u32,
            ) -> ::windows_core::Result<()> {
                unsafe { self.$field.GetAllocatedBlob(key, buffer, size) }
            }

            fn GetUnknown(
                &self,
                key: *const ::windows_core::GUID,
                riid: *const ::windows_core::GUID,
                object: *mut *mut ::core::ffi::c_void,
            ) -> ::windows_core::Result<()> {
                let inner = &self.$field;
                unsafe {
                    (::windows_core::Interface::vtable(inner).GetUnknown)(
                        ::windows_core::Interface::as_raw(inner),
                        key,
                        riid,
                        object,
                    )
                    .ok()
                }
            }

            fn SetItem(
                &self,
                key: *const ::windows_core::GUID,
                value: *const ::windows::Win32::System::Com::StructuredStorage::PROPVARIANT,
            ) -> ::windows_core::Result<()> {
                unsafe { self.$field.SetItem(key, value) }
            }

            fn DeleteItem(&self, key: *const ::windows_core::GUID) -> ::windows_core::Result<()> {
                unsafe { self.$field.DeleteItem(key) }
            }

            fn DeleteAllItems(&self) -> ::windows_core::Result<()> {
                unsafe { self.$field.DeleteAllItems() }
            }

            fn SetUINT32(&self, key: *const ::windows_core::GUID, value: u32) -> ::windows_core::Result<()> {
                unsafe { self.$field.SetUINT32(key, value) }
            }

            fn SetUINT64(&self, key: *const ::windows_core::GUID, value: u64) -> ::windows_core::Result<()> {
                unsafe { self.$field.SetUINT64(key, value) }
            }

            fn SetDouble(&self, key: *const ::windows_core::GUID, value: f64) -> ::windows_core::Result<()> {
                unsafe { self.$field.SetDouble(key, value) }
            }

            fn SetGUID(
                &self,
                key: *const ::windows_core::GUID,
                value: *const ::windows_core::GUID,
            ) -> ::windows_core::Result<()> {
                unsafe { self.$field.SetGUID(key, value) }
            }

            fn SetString(
                &self,
                key: *const ::windows_core::GUID,
                value: &::windows_core::PCWSTR,
            ) -> ::windows_core::Result<()> {
                let inner = &self.$field;
                unsafe {
                    (::windows_core::Interface::vtable(inner).SetString)(
                        ::windows_core::Interface::as_raw(inner),
                        key,
                        *value,
                    )
                    .ok()
                }
            }

            fn SetBlob(
                &self,
                key: *const ::windows_core::GUID,
                buffer: *const u8,
                size: u32,
            ) -> ::windows_core::Result<()> {
                let inner = &self.$field;
                unsafe {
                    (::windows_core::Interface::vtable(inner).SetBlob)(
                        ::windows_core::Interface::as_raw(inner),
                        key,
                        buffer,
                        size,
                    )
                    .ok()
                }
            }

            fn SetUnknown(
                &self,
                key: *const ::windows_core::GUID,
                value: ::windows_core::Ref<'_, ::windows_core::IUnknown>,
            ) -> ::windows_core::Result<()> {
                unsafe { self.$field.SetUnknown(key, value.as_ref()) }
            }

            fn LockStore(&self) -> ::windows_core::Result<()> {
                unsafe { self.$field.LockStore() }
            }

            fn UnlockStore(&self) -> ::windows_core::Result<()> {
                unsafe { self.$field.UnlockStore() }
            }

            fn GetCount(&self) -> ::windows_core::Result<u32> {
                unsafe { self.$field.GetCount() }
            }

            fn GetItemByIndex(
                &self,
                index: u32,
                key: *mut ::windows_core::GUID,
                value: *mut ::windows::Win32::System::Com::StructuredStorage::PROPVARIANT,
            ) -> ::windows_core::Result<()> {
                unsafe {
                    self.$field
                        .GetItemByIndex(index, key, (!value.is_null()).then_some(value))
                }
            }

            fn CopyAllItems(
                &self,
                dest: ::windows_core::Ref<'_, ::windows::Win32::Media::MediaFoundation::IMFAttributes>,
            ) -> ::windows_core::Result<()> {
                unsafe { self.$field.CopyAllItems(dest.as_ref()) }
            }
        }
    };
}

/// Implements `IMFMediaEventGenerator_Impl` for `$ty` by forwarding to the
/// queue returned by its `event_queue()` method (`MF_E_SHUTDOWN` after
/// shutdown). The queue is cloned out of any lock first: `GetEvent` blocks.
macro_rules! forward_event_generator {
    ($ty:ty) => {
        impl ::windows::Win32::Media::MediaFoundation::IMFMediaEventGenerator_Impl for $ty {
            fn GetEvent(
                &self,
                flags: ::windows::Win32::Media::MediaFoundation::MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS,
            ) -> ::windows_core::Result<::windows::Win32::Media::MediaFoundation::IMFMediaEvent> {
                let queue = self.event_queue()?;
                unsafe { queue.GetEvent(flags.0) }
            }

            fn BeginGetEvent(
                &self,
                callback: ::windows_core::Ref<'_, ::windows::Win32::Media::MediaFoundation::IMFAsyncCallback>,
                state: ::windows_core::Ref<'_, ::windows_core::IUnknown>,
            ) -> ::windows_core::Result<()> {
                let queue = self.event_queue()?;
                unsafe { queue.BeginGetEvent(callback.as_ref(), state.as_ref()) }
            }

            fn EndGetEvent(
                &self,
                result: ::windows_core::Ref<'_, ::windows::Win32::Media::MediaFoundation::IMFAsyncResult>,
            ) -> ::windows_core::Result<::windows::Win32::Media::MediaFoundation::IMFMediaEvent> {
                let queue = self.event_queue()?;
                unsafe { queue.EndGetEvent(result.as_ref()) }
            }

            fn QueueEvent(
                &self,
                event_type: u32,
                extended_type: *const ::windows_core::GUID,
                status: ::windows_core::HRESULT,
                value: *const ::windows::Win32::System::Com::StructuredStorage::PROPVARIANT,
            ) -> ::windows_core::Result<()> {
                let queue = self.event_queue()?;
                unsafe { queue.QueueEventParamVar(event_type, extended_type, status, value) }
            }
        }
    };
}

/// `IKsControl` with no property sets: every request is "set not found",
/// which tells the Frame Server the camera exposes no KS controls.
macro_rules! no_ks_control {
    ($ty:ty) => {
        impl ::windows::Win32::Media::KernelStreaming::IKsControl_Impl for $ty {
            fn KsProperty(
                &self,
                _property: *const ::windows::Win32::Media::KernelStreaming::KSIDENTIFIER,
                _length: u32,
                _data: *mut ::core::ffi::c_void,
                _data_length: u32,
                _returned: *mut u32,
            ) -> ::windows_core::Result<()> {
                Err($crate::util::set_not_found())
            }

            fn KsMethod(
                &self,
                _method: *const ::windows::Win32::Media::KernelStreaming::KSIDENTIFIER,
                _length: u32,
                _data: *mut ::core::ffi::c_void,
                _data_length: u32,
                _returned: *mut u32,
            ) -> ::windows_core::Result<()> {
                Err($crate::util::set_not_found())
            }

            fn KsEvent(
                &self,
                _event: *const ::windows::Win32::Media::KernelStreaming::KSIDENTIFIER,
                _length: u32,
                _data: *mut ::core::ffi::c_void,
                _data_length: u32,
                _returned: *mut u32,
            ) -> ::windows_core::Result<()> {
                Err($crate::util::set_not_found())
            }
        }
    };
}
