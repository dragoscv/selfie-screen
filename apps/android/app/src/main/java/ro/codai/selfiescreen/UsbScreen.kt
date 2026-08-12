package ro.codai.selfiescreen

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
/** Finds the Turing panel over USB OTG and opens a [TuringLcd]. */
object UsbScreen {

    const val ACTION_USB_PERMISSION = "ro.codai.selfiescreen.USB_PERMISSION"

    fun findPanel(context: Context): UsbDevice? {
        val usb = context.getSystemService(Context.USB_SERVICE) as UsbManager
        return usb.deviceList.values.firstOrNull { d ->
            d.vendorId == 0x1A86 && (d.productId == 0x5722 || d.productId == 0xCA21)
        }
    }

    fun hasPermission(context: Context, device: UsbDevice): Boolean {
        val usb = context.getSystemService(Context.USB_SERVICE) as UsbManager
        return usb.hasPermission(device)
    }

    fun requestPermission(context: Context, device: UsbDevice, onResult: (Boolean) -> Unit) {
        val usb = context.getSystemService(Context.USB_SERVICE) as UsbManager
        val flags = PendingIntent.FLAG_IMMUTABLE
        val pi = PendingIntent.getBroadcast(
            context, 0,
            Intent(ACTION_USB_PERMISSION).setPackage(context.packageName), flags
        )
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                context.unregisterReceiver(this)
                onResult(intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false))
            }
        }
        val filter = IntentFilter(ACTION_USB_PERMISSION)
        if (Build.VERSION.SDK_INT >= 33) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            context.registerReceiver(receiver, filter)
        }
        usb.requestPermission(device, pi)
    }

    /** Opens the panel; caller owns the returned LCD. Throws on failure. */
    fun open(context: Context, device: UsbDevice): TuringLcd {
        val usb = context.getSystemService(Context.USB_SERVICE) as UsbManager
        val connection = usb.openDevice(device)
            ?: throw IllegalStateException("openDevice failed (permission?)")
        val lcd = TuringLcd(device, connection)
        lcd.initialize()
        Thread.sleep(50)
        lcd.setOrientationPortrait()
        lcd.screenOn()
        lcd.setBrightness(90)
        return lcd
    }
}
