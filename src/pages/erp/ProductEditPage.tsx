import { useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/Skeleton";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Switch } from "@/components/ui/Switch";
import { NativeSelect } from "@/components/ui/Select";
import { MultiSelect } from "@/components/ui/MultiSelect";
import { BreadcrumbNav } from "@/components/ui/BreadcrumbNav";
import { FormField } from "@/components/ui/FormField";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/Tooltip";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/ActionsMenu";
import { ProductImages } from "@/components/media/ProductImages";
import { ProductStockCard } from "@/components/products/ProductStockCard";
import { AddToCartButton } from "@/components/pos/AddToCartButton";
import { ProductVehicleSection } from "@/components/products/ProductVehicleSection";
import { ProductNotesSection } from "@/components/products/ProductNotesSection";
import { FormSection } from "@/components/products/FormSection";
import { ProductLivePreviewCard } from "@/components/products/ProductLivePreviewCard";
import { ProductEssentialsProgress } from "@/components/products/ProductEssentialsProgress";
import { SendProductEmailModal } from "@/components/products/SendProductEmailModal";
import { useToast } from "@/context";
import {
  getProduct,
  updateProduct,
} from "@/lib/api/products";
import { getCategories } from "@/lib/api/categories";
import { getChannels } from "@/lib/api/channels";
import { createGoogleListing } from "@/lib/api/googleListings";
import { GOOGLE_LISTING_FORM_INITIAL } from "@/types/marketplace";
import type { Product } from "@/types/product";
import { formatCurrency } from "@/utils/format";
import {
  ShoppingBag,
  ShoppingCart,
  ChevronDown,
  CheckCircle2,
  Mail,
} from "lucide-react";
import { CONDITIONS, AUTHENTICITY_OPTIONS } from "@/config/productOptions";
import { productEditFormSchema, type ProductEditFormValues } from "@/lib/validation/product";

// ── Helpers ───────────────────────────────────────────────────────────────────

function productToForm(p: Product): ProductEditFormValues {
  return {
    title: p.title,
    description: p.description,
    price: p.price?.toString() ?? "",
    compare_price: p.compare_price?.toString() ?? "",
    cost_price: p.cost_price?.toString() ?? "",
    shipping_cost: p.shipping_cost?.toString() ?? "",
    is_taxable: p.is_taxable,
    sku: p.sku ?? "",
    barcode: p.barcode ?? "",
    brand: p.brand ?? "",
    mpn: p.mpn ?? "",
    condition: p.condition,
    authenticity: p.authenticity ?? "",
    vehicle_make: p.vehicle?.make ?? "",
    vehicle_model: p.vehicle?.model ?? "",
    vehicle_model_code: p.vehicle?.model_code ?? "",
    vehicle_year: p.vehicle?.year_from != null ? String(p.vehicle.year_from) : "",
    vehicle_year_to: p.vehicle?.year_to != null ? String(p.vehicle.year_to) : "",
    type: p.type,
    status: p.status,
    is_published_online: p.is_published_online,
    has_variants: p.has_variants,
    categories: p.categories?.map((c) => c._id) ?? [],
    tags: p.tags ?? [],
    images: p.attachments ?? [],
    choices: p.choices?.map((c) => ({ name: c.name, items: c.items })) ?? [],
  };
}

function formToFD(form: ProductEditFormValues): FormData {
  const fd = new FormData();
  fd.append("title", form.title.trim());
  fd.append("description", form.description);
  fd.append("price", form.price || "0");
  fd.append("compare_price", form.compare_price || "");
  fd.append("cost_price", form.cost_price || "");
  fd.append("shipping_cost", form.shipping_cost || "");
  fd.append("is_taxable", String(form.is_taxable));
  fd.append("sku", form.sku);
  fd.append("barcode", form.barcode);
  fd.append("brand", form.brand);
  fd.append("mpn", form.mpn);
  fd.append("condition", form.condition);
  fd.append("authenticity", form.authenticity);
  fd.append(
    "vehicle",
    JSON.stringify({
      make: form.vehicle_make || null,
      model: form.vehicle_model || null,
      model_code: form.vehicle_model_code || null,
      year_from: form.vehicle_year ? Number(form.vehicle_year) : null,
      year_to: form.vehicle_year_to ? Number(form.vehicle_year_to) : null,
    }),
  );
  fd.append("type", form.type);
  fd.append("status", form.status);
  fd.append("is_published_online", String(form.is_published_online));
  // Stock is always tracked — there's no "track stock" toggle in the UI.
  fd.append("stock_control", "true");
  fd.append("has_variants", String(form.has_variants));
  fd.append("categories", JSON.stringify(form.categories));
  fd.append("tags", JSON.stringify(form.tags));
  fd.append(
    "attachments",
    JSON.stringify(form.images.map((img) => img._id || img.id).filter(Boolean)),
  );
  fd.append("choices", JSON.stringify(form.choices));
  return fd;
}

// ── Skeleton ──────────────────────────────────────────────────────────────────
function ProductEditSkeleton() {
  return (
    <div className="space-y-5 pb-24">
      {/* Header */}
      <div className="space-y-2">
        <Skeleton className="h-3 w-32" />
        <div className="flex items-center justify-between">
          <div className="space-y-1.5">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-3 w-24" />
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-8 w-16" />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Main column */}
        <div className="space-y-5 lg:col-span-2">
          {[180, 120, 100].map((h, i) => (
            <div key={i} className="rounded-xs border border-border bg-card p-5 space-y-4">
              <Skeleton className="h-4 w-36" />
              <Skeleton className={`h-${h === 180 ? 10 : 10} w-full`} />
              {h === 180 && <Skeleton className="h-32 w-full" />}
            </div>
          ))}
        </div>
        {/* Sidebar */}
        <div className="space-y-5">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded-xs border border-border bg-card p-5 space-y-3">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
// Thin data-loading shell — the real form (ProductEditForm below) only ever
// mounts once `product` is guaranteed non-null, so useForm's defaultValues
// can be built from real data on its very first render. Building the form
// with product-or-undefined defaultValues and reset()-ing once data arrives
// (the naive approach) leaves a render frame, right after the query
// resolves but before the effect runs, where the loading guard has already
// passed but the form is still empty — this sidesteps that race entirely
// rather than patching around it.
export default function ProductEditPage() {
  const { slug } = useParams<{ slug: string }>();

  const { data: productData, isLoading } = useQuery({
    queryKey: ["product", slug],
    queryFn: () => getProduct(slug!),
    enabled: !!slug,
  });
  const product = productData?.data;

  const { data: categoriesRes } = useQuery({
    queryKey: ["categories", "all"],
    queryFn: () => getCategories({ limit: 100 }),
    staleTime: 5 * 60 * 1000,
  });
  const categoryOptions = (categoriesRes?.data?.items ?? []).map((c) => ({
    value: c._id,
    label: c.name,
  }));

  if (isLoading || !product || !slug) {
    return <ProductEditSkeleton />;
  }

  return <ProductEditForm key={product._id} product={product} slug={slug} categoryOptions={categoryOptions} />;
}

function ProductEditForm({
  product,
  slug,
  categoryOptions,
}: {
  product: Product;
  slug: string;
  categoryOptions: { value: string; label: string }[];
}) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [imagesUploading, setImagesUploading] = useState(false);
  const [sendEmailOpen, setSendEmailOpen] = useState(false);

  // Same queryKey GoogleConnectCard uses — shares its cache, so this doesn't
  // fire a second request if the tenant already loaded Settings this
  // session, and vice versa.
  const { data: channelsData } = useQuery({ queryKey: ["channels"], queryFn: getChannels });
  const googleConnected = channelsData?.data.find((c) => c.key === "google")?.connection.status === "connected";

  // "Lightweight toggle" — see google.listing.service.js's own module
  // header: unlike eBay's multi-step form-then-push flow (the "List on
  // eBay" button below just navigates to that form), this one action both
  // creates the listing and queues its first sync. Safe to click again —
  // the backend's own idempotency check returns the existing listing rather
  // than erroring or duplicating it.
  const listOnGoogleMutation = useMutation({
    mutationFn: () => createGoogleListing(product._id, null, GOOGLE_LISTING_FORM_INITIAL),
    onSuccess: () => {
      toast({ title: "Queued for Google Shopping sync", tone: "success" });
      queryClient.invalidateQueries({ queryKey: ["listings"] });
      queryClient.invalidateQueries({ queryKey: ["listings-for-products"] });
    },
    onError: (err: Error) => toast({ title: err.message, tone: "danger" }),
  });

  const {
    register,
    control,
    handleSubmit,
    reset,
    setValue,
    getValues,
    watch,
    formState: { errors, isDirty },
  } = useForm<ProductEditFormValues>({
    resolver: zodResolver(productEditFormSchema),
    defaultValues: productToForm(product),
  });

  const form = watch();

  const saveMutation = useMutation({
    mutationFn: (fd: FormData) => updateProduct(product!._id, fd),
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, tone: "danger" });
    },
  });

  // Immediate, independent of the main Save flow — mirrors the Products list's
  // publish/hide toggle. Rebases the form's dirty-tracking baseline (via
  // reset) to include the new status, so an in-progress edit's dirty state
  // stays accurate and a later Save doesn't silently revert the status back.
  const statusMutation = useMutation({
    mutationFn: (status: Product["status"]) => {
      const fd = new FormData();
      fd.append("status", status);
      return updateProduct(product!._id, fd);
    },
    onSuccess: (_res, status) => {
      reset({ ...getValues(), status }, { keepDirty: false });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["product", slug] });
      toast({ title: "Product marked as active", tone: "success" });
    },
    onError: (err: Error) => {
      toast({ title: "Couldn't update status", description: err.message, tone: "danger" });
    },
  });

  const onSave = (values: ProductEditFormValues) => {
    if (!product) return;
    saveMutation.mutate(formToFD(values), {
      onSuccess: (res) => {
        reset(values);
        queryClient.invalidateQueries({ queryKey: ["products"] });
        queryClient.invalidateQueries({ queryKey: ["listings"] });
        queryClient.invalidateQueries({ queryKey: ["variants", product?._id] });
        toast({ title: "Saved", tone: "success" });
        const newSlug = res.data?.slug;
        if (newSlug && newSlug !== slug) {
          // Slug changed: just navigate — don't touch the old query.
          // Removing it while the component is still subscribed causes RQ to
          // immediately refetch the now-dead URL. Leaving it in cache is safe:
          // it loses its subscriber on re-render and gets GC'd after gcTime.
          navigate(`/products/${newSlug}/edit`, { replace: true });
        } else {
          queryClient.invalidateQueries({ queryKey: ["product", slug] });
        }
      },
    });
  };

  const showSetStockCard = !form.has_variants;

  const essentials = [
    form.title.trim().length > 0,
    Number(form.price) > 0,
    form.categories.length > 0,
    form.images.length > 0,
  ];
  const essentialsCompleted = essentials.filter(Boolean).length;

  const priceNumber = Number(form.price) || 0;
  const costNumber = Number(form.cost_price) || 0;
  const hasMargin = priceNumber > 0 && form.cost_price !== "";
  const profitPerUnit = priceNumber - costNumber;
  const marginPct = hasMargin ? Math.round((profitPerUnit / priceNumber) * 100) : null;

  return (
    <div className="space-y-5 pb-24">

      {/* Sticky page header */}
      <div className="sticky top-0 z-30 -mx-6 border-b border-border bg-bg/95 px-6 py-3 backdrop-blur-sm">
        <BreadcrumbNav
          items={[
            { label: "Products", href: "/products" },
            { label: product.title },
          ]}
        />
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <h1 className="truncate text-xl font-semibold tracking-tight">{product.title}</h1>
              </TooltipTrigger>
              <TooltipContent side="bottom">{product.title}</TooltipContent>
            </Tooltip>
            <p className="mt-0.5 truncate text-sm text-fg/45">/{product.slug}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <ProductEssentialsProgress completed={essentialsCompleted} total={essentials.length} />
            {product.status === "active" ? (
              <Badge variant="ok" className="hidden sm:inline-flex">Active</Badge>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger className="hidden h-auto w-auto items-center gap-1 rounded-full px-0 py-0 text-fg/40 hover:bg-transparent hover:text-fg/40 data-[state=open]:bg-transparent data-[state=open]:text-fg/40 sm:inline-flex">
                  <Badge variant="muted" className="cursor-pointer">
                    Draft
                    <ChevronDown className="h-3 w-3" />
                  </Badge>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem
                    onSelect={() => statusMutation.mutate("active")}
                    disabled={statusMutation.isPending}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 text-fg/50" />
                    Active
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <div className="flex items-center">
              <AddToCartButton product={product} display="labeled" className="rounded-r-none" />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    className="h-9 w-6 rounded-l-none border-l border-border px-0"
                    title="More actions"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setSendEmailOpen(true)}>
                    <Mail className="h-3.5 w-3.5 text-fg/50" />
                    Send Email
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="gap-1.5"
              onClick={() => navigate(`/listings/new?product=${product._id}&productSlug=${product.slug}`)}
            >
              <ShoppingBag className="h-3.5 w-3.5" />
              List on eBay
            </Button>
            {googleConnected && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="gap-1.5"
                disabled={listOnGoogleMutation.isPending}
                onClick={() => listOnGoogleMutation.mutate()}
              >
                <ShoppingCart className="h-3.5 w-3.5" />
                {listOnGoogleMutation.isPending ? "Listing…" : "List on Google Shopping"}
              </Button>
            )}
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={!isDirty || saveMutation.isPending || imagesUploading}
              onClick={() => handleSubmit(onSave)()}
            >
              {saveMutation.isPending ? "Saving…" : imagesUploading ? "Uploading images…" : "Save"}
            </Button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">

          {/* 1. Basics */}
          <FormSection number={1} title="Basics">
            <FormField label="Product title" required error={errors.title?.message}>
              <Input {...register("title")} placeholder="Product title" />
            </FormField>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <FormField label="SKU">
                <Input
                  value={form.sku}
                  readOnly
                  disabled
                  placeholder="Not assigned"
                  className="cursor-not-allowed font-mono opacity-60"
                />
              </FormField>

              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-fg/65">Barcode</label>
                  <span className="text-[10px] tabular-nums text-fg/35">{form.barcode.length}/13</span>
                </div>
                <Input {...register("barcode")} placeholder="EAN / UPC" maxLength={13} />
              </div>

              <FormField label="Manufacturer part number">
                <Input {...register("mpn")} placeholder='e.g. 45022-TBC-A01' />
              </FormField>
            </div>

            <Controller
              control={control}
              name="is_published_online"
              render={({ field }) => (
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  label="Show on storefront"
                  description="Visible to customers online as soon as it's created"
                />
              )}
            />
          </FormSection>

          {/* 2. Classification & fitment */}
          <FormSection number={2} title="Classification & fitment">
            <FormField label="Categories">
              <Controller
                control={control}
                name="categories"
                render={({ field }) => (
                  <MultiSelect
                    options={categoryOptions}
                    value={field.value}
                    onChange={field.onChange}
                    placeholder="Add category…"
                    searchPlaceholder="Search categories…"
                  />
                )}
              />
            </FormField>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label="Condition">
                <NativeSelect {...register("condition")}>
                  {CONDITIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </NativeSelect>
              </FormField>

              <FormField label="Authenticity">
                <NativeSelect {...register("authenticity")}>
                  <option value="">Select authenticity…</option>
                  {AUTHENTICITY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </NativeSelect>
              </FormField>
            </div>

            <div className="border-t border-dashed border-border pt-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="text-sm font-semibold text-fg">Vehicle fitment</span>
                <Badge variant="muted">Optional</Badge>
              </div>
              <ProductVehicleSection
                values={{
                  vehicle_make: form.vehicle_make,
                  vehicle_model: form.vehicle_model,
                  vehicle_model_code: form.vehicle_model_code,
                  vehicle_year: form.vehicle_year,
                  vehicle_year_to: form.vehicle_year_to,
                }}
                onChange={(patch) => {
                  for (const [key, value] of Object.entries(patch)) {
                    setValue(key as keyof ProductEditFormValues, value as never, { shouldValidate: true, shouldDirty: true });
                  }
                }}
                yearRangeError={errors.vehicle_year_to?.message}
              />
            </div>
          </FormSection>

          {/* 3. Pricing */}
          <FormSection number={3} title="Pricing" tag={<span className="text-xs text-fg/40">All amounts in A$</span>}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <FormField label="Retail price" required error={errors.price?.message}>
                <Input type="number" min="0" step="0.01" {...register("price")} placeholder="0.00" />
              </FormField>
              <FormField label="Cost price" error={errors.cost_price?.message}>
                <Input type="number" min="0" step="0.01" {...register("cost_price")} placeholder="0.00" />
              </FormField>
              <FormField label="Shipping cost" error={errors.shipping_cost?.message}>
                <Input type="number" min="0" step="0.01" {...register("shipping_cost")} placeholder="0.00" />
              </FormField>
            </div>

            <div className="flex flex-wrap items-center gap-4 rounded-xs border border-border bg-bg-2/40 px-4 py-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-fg/40">Margin</p>
                <p className="mt-0.5 text-sm font-semibold text-fg">{hasMargin ? `${marginPct}%` : "—"}</p>
              </div>
              <div className="h-8 w-px bg-border" />
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-fg/40">Profit per unit</p>
                <p className="mt-0.5 text-sm font-semibold text-fg">
                  {hasMargin ? formatCurrency(profitPerUnit) : "—"}
                </p>
              </div>
              {!hasMargin && (
                <p className="text-xs text-fg/45">Enter retail and cost to see live margin.</p>
              )}
            </div>
          </FormSection>

          {/* 4. Stock */}
          <FormSection
            number={4}
            title="Stock"
            description="Manage stock for your only location"
          >
            {showSetStockCard && <ProductStockCard productId={product._id} />}
          </FormSection>

          {/* 5. Media */}
          <FormSection
            number={5}
            title="Media"
            description="First image is used as the product cover"
            tag={<Badge variant="outline">{form.images.length} {form.images.length === 1 ? "Image" : "Images"}</Badge>}
          >
            <Controller
              control={control}
              name="images"
              render={({ field }) => (
                <ProductImages images={field.value} onChange={field.onChange} onUploadingChange={setImagesUploading} />
              )}
            />
          </FormSection>

          {/* 6. Internal notes */}
          <ProductNotesSection
            number={6}
            productId={product._id}
            slug={product.slug}
            notes={product.internal_notes}
          />

        </div>

        {/* Sidebar */}
        <div className="space-y-5 lg:sticky lg:top-24 lg:self-start">
          <ProductLivePreviewCard
            title={form.title}
            images={form.images}
            price={form.price}
            sku={form.sku}
            stockCount={product.stock_count}
          />
        </div>
      </div>

      <SendProductEmailModal product={product} open={sendEmailOpen} onOpenChange={setSendEmailOpen} />
    </div>
  );
}
