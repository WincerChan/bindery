import { getTransferService as getKindleTransferService } from "../kindle/transfer";
import type { PairedDevice } from "./identity";
import type { TransferOptions, TransferResult, TransferService } from "./queue";
import { getKoboTransferService } from "./kobo/transfer";

/** Kind-neutral transfer facade. Kindle keeps KFX + thumbnails; Kobo writes KEPUB. */
export class DeviceTransferService implements TransferService {
  transferBook(device: PairedDevice, bookId: string, profileId = "default", options: TransferOptions = {}): Promise<TransferResult> {
    return device.identity.kind === "kobo"
      ? getKoboTransferService().transferBook(device, bookId, profileId, options)
      : getKindleTransferService().transferBook(device, bookId, profileId, options);
  }
}
let shared: DeviceTransferService | undefined;
export const getDeviceTransferService = () => shared ??= new DeviceTransferService();
export const transferBook = (device: PairedDevice, bookId: string, profileId = "default", options?: TransferOptions) => getDeviceTransferService().transferBook(device, bookId, profileId, options);
