import { useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { FormField } from "@/components/ui/FormField";
import { Switch } from "@/components/ui/Switch";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalFooter,
  ModalTitle,
  ModalDescription,
} from "@/components/ui/Modal";
import { useToast } from "@/context";
import { getInventorySettings, updateInventorySettings } from "@/lib/api/inventory";
import { inventorySettingsFormSchema, type InventorySettingsFormValues } from "@/lib/validation/inventorySettings";
import { utcTimeToSydney, sydneyTimeToUtc } from "@/utils/timezone";

interface InventorySettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DEFAULT_FORM: InventorySettingsFormValues = {
  threshold: "10",
  emailEnabled: false,
  email: "",
  sendTime: "22:00",
};

export function InventorySettingsModal({ open, onOpenChange }: InventorySettingsModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["inventory-settings"],
    queryFn: getInventorySettings,
    enabled: open,
  });
  const settings = data?.data;

  const {
    register,
    control,
    handleSubmit,
    reset,
  } = useForm<InventorySettingsFormValues>({
    resolver: zodResolver(inventorySettingsFormSchema),
    defaultValues: DEFAULT_FORM,
  });

  useEffect(() => {
    if (settings) {
      reset({
        threshold: String(settings.low_stock_threshold),
        emailEnabled: settings.email_notifications,
        email: settings.notification_email ?? "",
        // Stored in the DB as UTC — displayed/edited here in Sydney local
        // time (see src/utils/timezone.ts for why Sydney is hardcoded).
        sendTime: utcTimeToSydney(settings.notification_send_time || "22:00"),
      });
    }
  }, [settings, reset]);

  const mutation = useMutation({
    mutationFn: (values: InventorySettingsFormValues) =>
      updateInventorySettings({
        low_stock_threshold: Number(values.threshold) || 0,
        email_notifications: values.emailEnabled,
        notification_email: values.email || null,
        // Convert back to UTC before it hits the API — the form field
        // itself is always Sydney local time.
        notification_send_time: sydneyTimeToUtc(values.sendTime),
      }),
    onSuccess: () => {
      toast({ title: "Inventory settings saved", tone: "success" });
      queryClient.invalidateQueries({ queryKey: ["inventory-settings"] });
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast({ title: "Couldn't save settings", description: err.message, tone: "danger" });
    },
  });

  const onSubmit = (values: InventorySettingsFormValues) => mutation.mutate(values);

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="max-w-lg">
        <form onSubmit={handleSubmit(onSubmit)}>
          <ModalHeader>
            <ModalTitle>Inventory Settings</ModalTitle>
            <ModalDescription>Configure stock tracking preferences like low-stock thresholds</ModalDescription>
          </ModalHeader>

          <div className="space-y-4">
            <FormField
              label="Low Stock Threshold"
              hint="Alert when a variant's stock falls at or below this number."
            >
              <div className="flex items-center gap-2">
                <Input type="number" min="0" className="max-w-32" {...register("threshold")} />
                <span className="text-sm text-fg/50">units</span>
              </div>
            </FormField>

            <Controller
              control={control}
              name="emailEnabled"
              render={({ field }) => (
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  label="Email Notifications"
                  description={field.value ? "Low stock alerts are active" : "Low stock alerts are off"}
                />
              )}
            />

            <FormField label="Recipient Email">
              <Input type="email" placeholder="you@example.com" {...register("email")} />
            </FormField>

            <FormField label="Send Time" hint="Daily time to send the low stock digest.">
              <Input type="time" className="max-w-40" {...register("sendTime")} />
            </FormField>
          </div>

          <ModalFooter>
            <Button type="button" variant="secondary" size="md" disabled={mutation.isPending} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="md" disabled={mutation.isPending}>
              {mutation.isPending ? "Saving…" : "Save changes"}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
